'use strict';

const { broadcast } = require('../../core/websocket');

const jobs = new Map();
const MAX_OUTPUT_LINES = 50;
const MAX_KEPT_JOBS = 20;
const PRUNE_AGE_MS = 60 * 60 * 1000; // 1 hour
let broadcastInterval = null;

function generateId(type) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `${type}_${ts}_${rand}`;
}

function hasActiveJob(type) {
  for (const job of jobs.values()) {
    if (job.type === type && job.status === 'running') return true;
  }
  return false;
}

function createJob(type, label, childProcess) {
  if (hasActiveJob(type)) {
    throw new Error(`A ${type} job is already running`);
  }

  const id = generateId(type);
  const job = {
    id,
    type,
    status: 'running',
    label,
    startedAt: Date.now(),
    finishedAt: null,
    output: [],
    result: null,
    _process: childProcess,
    pid: childProcess.pid || null,
  };

  function appendLine(line) {
    const trimmed = line.replace(/\r/g, '').trim();
    if (!trimmed) return;
    job.output.push(trimmed);
    if (job.output.length > MAX_OUTPUT_LINES) {
      job.output.shift();
    }
  }

  childProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) appendLine(line);
  });

  childProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) appendLine(line);
  });

  childProcess.on('close', (code) => {
    job.finishedAt = Date.now();
    if (job.status === 'cancelled') return;
    if (code === 0) {
      job.status = 'completed';
    } else {
      job.status = 'failed';
      job.result = `Process exited with code ${code}`;
    }
    broadcastJobs();
  });

  childProcess.on('error', (err) => {
    job.finishedAt = Date.now();
    job.status = 'failed';
    job.result = err.message;
    broadcastJobs();
  });

  jobs.set(id, job);
  pruneOldJobs();
  broadcastJobs();

  return job;
}

function getJobs() {
  const all = Array.from(jobs.values());
  const active = all.filter((j) => j.status === 'running');
  const done = all.filter((j) => j.status !== 'running');
  done.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  return [...active, ...done].map(serialize);
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? serialize(job) : null;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  job.result = 'Cancelled by user';
  try {
    job._process.kill('SIGTERM');
  } catch { /* ignore */ }
  broadcastJobs();
  return true;
}

function setJobResult(id, result) {
  const job = jobs.get(id);
  if (job) job.result = result;
}

function serialize(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    label: job.label,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsed: job.finishedAt
      ? job.finishedAt - job.startedAt
      : Date.now() - job.startedAt,
    output: job.output.slice(-20),
    result: job.result,
    pid: job.pid,
  };
}

function pruneOldJobs() {
  const now = Date.now();
  const entries = Array.from(jobs.entries());
  for (const [id, job] of entries) {
    if (job.status !== 'running' && job.finishedAt && (now - job.finishedAt) > PRUNE_AGE_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size > MAX_KEPT_JOBS) {
    const sorted = entries
      .filter(([, j]) => j.status !== 'running')
      .sort((a, b) => (a[1].finishedAt || 0) - (b[1].finishedAt || 0));
    while (jobs.size > MAX_KEPT_JOBS && sorted.length > 0) {
      const [id] = sorted.shift();
      jobs.delete(id);
    }
  }
}

function broadcastJobs() {
  const active = Array.from(jobs.values())
    .filter((j) => j.status === 'running')
    .map(serialize);
  const recent = Array.from(jobs.values())
    .filter((j) => j.status !== 'running' && j.finishedAt && (Date.now() - j.finishedAt) < 60000)
    .map(serialize);
  broadcast('backtest:jobs', [...active, ...recent]);
}

function startBroadcastLoop() {
  if (broadcastInterval) return;
  broadcastInterval = setInterval(() => {
    const hasActive = Array.from(jobs.values()).some((j) => j.status === 'running');
    const hasRecent = Array.from(jobs.values()).some(
      (j) => j.status !== 'running' && j.finishedAt && (Date.now() - j.finishedAt) < 60000
    );
    if (hasActive || hasRecent) broadcastJobs();
  }, 2000);
}

function stopBroadcastLoop() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
}

function cancelAllRunning() {
  for (const [id, job] of jobs) {
    if (job.status === 'running') cancelJob(id);
  }
}

module.exports = {
  createJob,
  getJobs,
  getJob,
  cancelJob,
  setJobResult,
  hasActiveJob,
  startBroadcastLoop,
  stopBroadcastLoop,
  cancelAllRunning,
};
