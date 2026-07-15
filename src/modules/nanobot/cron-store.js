'use strict';

const fs = require('fs');
const path = require('path');
const { CronExpressionParser } = require('cron-parser');
const { v4: uuidv4 } = require('uuid');
const config = require('../../../config/default');

function nowMs() {
  return Date.now();
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveJobsPath(cronCfg) {
  const p = (cronCfg && cronCfg.jobsJsonPath) || '';
  if (!p) return null;
  if (!path.isAbsolute(p)) {
    throw httpError(500, 'Cron jobs path must be absolute');
  }
  const resolved = path.resolve(p);
  const bases = (cronCfg && cronCfg.allowedBasePaths) || [];
  if (bases.length > 0) {
    const ok = bases.some((base) => {
      const rb = path.resolve(base.trim());
      return resolved === rb || resolved.startsWith(rb + path.sep);
    });
    if (!ok) throw httpError(500, 'Cron jobs path is not under an allowed base directory');
  }
  return resolved;
}

function validateTimezone(tz) {
  if (tz == null || tz === '') return;
  /** Node's Intl list omits some IANA names cron-parser still accepts (e.g. UTC). */
  if (tz === 'UTC' || tz === 'GMT' || tz === 'Etc/UTC' || tz === 'Etc/GMT') return;
  const list = Intl.supportedValuesOf('timeZone');
  if (!list.includes(tz)) throw httpError(400, `Unknown timezone: ${tz}`);
}

function validateScheduleShape(s) {
  if (!s || typeof s !== 'object') throw httpError(400, 'Invalid schedule');
  const kind = s.kind;
  if (!['at', 'every', 'cron'].includes(kind)) {
    throw httpError(400, 'schedule.kind must be at, every, or cron');
  }
  if (s.tz != null && s.tz !== '' && kind !== 'cron') {
    throw httpError(400, 'tz is only valid for cron schedules');
  }
  if (kind === 'at') {
    const at = s.atMs;
    if (at == null || typeof at !== 'number' || !Number.isFinite(at)) {
      throw httpError(400, 'schedule.atMs required (number) for at kind');
    }
  } else if (kind === 'every') {
    const ev = s.everyMs;
    if (ev == null || typeof ev !== 'number' || !Number.isFinite(ev) || ev <= 0) {
      throw httpError(400, 'schedule.everyMs must be a positive number for every kind');
    }
  } else if (kind === 'cron') {
    if (!s.expr || typeof s.expr !== 'string' || !s.expr.trim()) {
      throw httpError(400, 'schedule.expr required for cron kind');
    }
    const tzUse = s.tz && String(s.tz).trim() ? s.tz : 'UTC';
    validateTimezone(tzUse);
    try {
      CronExpressionParser.parse(s.expr.trim(), { currentDate: new Date(nowMs()), tz: tzUse });
    } catch (e) {
      throw httpError(400, `Invalid cron expression: ${e.message}`);
    }
  }
}

function normalizeSchedule(s) {
  const kind = s.kind;
  const out = { kind, atMs: null, everyMs: null, expr: null, tz: null };
  if (kind === 'at') out.atMs = s.atMs;
  if (kind === 'every') out.everyMs = s.everyMs;
  if (kind === 'cron') {
    out.expr = String(s.expr).trim();
    out.tz = s.tz && String(s.tz).trim() ? String(s.tz).trim() : null;
  }
  return out;
}

function validatePayloadShape(p) {
  if (!p || typeof p !== 'object') throw httpError(400, 'Invalid payload');
  const kind = p.kind != null ? p.kind : 'agent_turn';
  if (!['agent_turn', 'system_event'].includes(kind)) {
    throw httpError(400, 'payload.kind must be agent_turn or system_event');
  }
  if (typeof p.message !== 'string') throw httpError(400, 'payload.message must be a string');
  if (p.deliver != null && typeof p.deliver !== 'boolean') {
    throw httpError(400, 'payload.deliver must be boolean');
  }
  if (p.channel != null && typeof p.channel !== 'string') {
    throw httpError(400, 'payload.channel must be string');
  }
  if (p.to != null && typeof p.to !== 'string') throw httpError(400, 'payload.to must be string');
}

function normalizePayload(p) {
  const kind = p.kind != null ? p.kind : 'agent_turn';
  return {
    kind,
    message: typeof p.message === 'string' ? p.message : '',
    deliver: Boolean(p.deliver),
    channel: p.channel != null && p.channel !== '' ? String(p.channel) : null,
    to: p.to != null && p.to !== '' ? String(p.to) : null,
  };
}

function computeNextRunMs(schedule, refMs = nowMs()) {
  const kind = schedule.kind;
  if (kind === 'at') {
    return schedule.atMs > refMs ? schedule.atMs : null;
  }
  if (kind === 'every') {
    return refMs + schedule.everyMs;
  }
  const tzUse = schedule.tz && String(schedule.tz).trim() ? schedule.tz : 'UTC';
  const expr = CronExpressionParser.parse(schedule.expr, {
    currentDate: new Date(refMs),
    tz: tzUse,
  });
  return expr.next().getTime();
}

function normalizeRunRecord(r) {
  return {
    runAtMs: r.runAtMs,
    status: r.status,
    durationMs: r.durationMs != null ? r.durationMs : 0,
    error: r.error != null ? r.error : null,
  };
}

function normalizeJob(j, { recomputeNext = true } = {}) {
  validateScheduleShape(j.schedule);
  validatePayloadShape(j.payload);
  const schedule = normalizeSchedule(j.schedule);
  const payload = normalizePayload(j.payload);
  const enabled = j.enabled !== false;
  const id = String(j.id || '').trim();
  if (!id) throw httpError(400, 'Job id required');
  const name = typeof j.name === 'string' ? j.name : '';
  if (!name.trim()) throw httpError(400, 'Job name required');

  const rawState = j.state && typeof j.state === 'object' ? j.state : {};
  const history = Array.isArray(rawState.runHistory) ? rawState.runHistory : [];
  const normalizedHistory = [];
  for (const r of history) {
    if (!r || typeof r !== 'object') continue;
    if (!['ok', 'error', 'skipped'].includes(r.status)) continue;
    if (typeof r.runAtMs !== 'number') continue;
    normalizedHistory.push(normalizeRunRecord(r));
  }

  const job = {
    id,
    name: name.trim(),
    enabled,
    schedule,
    payload,
    state: {
      nextRunAtMs: rawState.nextRunAtMs != null ? rawState.nextRunAtMs : null,
      lastRunAtMs: rawState.lastRunAtMs != null ? rawState.lastRunAtMs : null,
      lastStatus: rawState.lastStatus != null ? rawState.lastStatus : null,
      lastError: rawState.lastError != null ? rawState.lastError : null,
      runHistory: normalizedHistory.slice(-20),
    },
    createdAtMs: typeof j.createdAtMs === 'number' ? j.createdAtMs : nowMs(),
    updatedAtMs: typeof j.updatedAtMs === 'number' ? j.updatedAtMs : nowMs(),
    deleteAfterRun: Boolean(j.deleteAfterRun),
  };

  if (!enabled) {
    job.state.nextRunAtMs = null;
  } else if (recomputeNext) {
    try {
      job.state.nextRunAtMs = computeNextRunMs(schedule, nowMs());
    } catch {
      job.state.nextRunAtMs = null;
    }
  } else if (job.state.nextRunAtMs == null) {
    try {
      job.state.nextRunAtMs = computeNextRunMs(schedule, nowMs());
    } catch {
      job.state.nextRunAtMs = null;
    }
  }

  return job;
}

function validateFullStore(data, { recomputeNext = true, strict = false } = {}) {
  if (!data || typeof data !== 'object') throw httpError(400, 'Invalid store');
  const version = data.version != null ? Number(data.version) : 1;
  if (!Number.isInteger(version) || version < 1) throw httpError(400, 'Invalid version');
  const jobsIn = Array.isArray(data.jobs) ? data.jobs : [];
  const seen = new Set();
  const jobs = [];
  const parseErrors = [];
  for (let i = 0; i < jobsIn.length; i++) {
    const j = jobsIn[i];
    try {
      const job = normalizeJob(j, { recomputeNext });
      if (seen.has(job.id)) {
        if (strict) throw httpError(400, `Duplicate job id: ${job.id}`);
        parseErrors.push({ index: i, id: job.id, error: `Duplicate job id: ${job.id}` });
        continue;
      }
      seen.add(job.id);
      jobs.push(job);
    } catch (err) {
      if (strict) throw err;
      const rawId = j && typeof j === 'object' ? j.id || `[index ${i}]` : `[index ${i}]`;
      const rawName = j && typeof j === 'object' ? j.name || '' : '';
      parseErrors.push({ index: i, id: String(rawId), name: String(rawName), error: err.message });
    }
  }
  return { version, jobs, parseErrors };
}

function toDiskFormat(store) {
  return {
    version: store.version,
    jobs: store.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      schedule: {
        kind: j.schedule.kind,
        atMs: j.schedule.atMs,
        everyMs: j.schedule.everyMs,
        expr: j.schedule.expr,
        tz: j.schedule.tz,
      },
      payload: {
        kind: j.payload.kind,
        message: j.payload.message,
        deliver: j.payload.deliver,
        channel: j.payload.channel,
        to: j.payload.to,
      },
      state: {
        nextRunAtMs: j.state.nextRunAtMs,
        lastRunAtMs: j.state.lastRunAtMs,
        lastStatus: j.state.lastStatus,
        lastError: j.state.lastError,
        runHistory: j.state.runHistory.map((r) => ({
          runAtMs: r.runAtMs,
          status: r.status,
          durationMs: r.durationMs,
          error: r.error,
        })),
      },
      createdAtMs: j.createdAtMs,
      updatedAtMs: j.updatedAtMs,
      deleteAfterRun: j.deleteAfterRun,
    })),
  };
}

function readStore(cronCfg) {
  const jobsPath = resolveJobsPath(cronCfg);
  if (!jobsPath) return { configured: false, path: null, store: null };
  if (!fs.existsSync(jobsPath)) {
    return {
      configured: true,
      path: jobsPath,
      store: { version: 1, jobs: [], parseErrors: [] },
    };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  } catch (e) {
    throw httpError(500, `Failed to read cron store: ${e.message}`);
  }
  const store = validateFullStore(raw, { recomputeNext: false });
  return { configured: true, path: jobsPath, store };
}

function writeStore(cronCfg, store, { recomputeNext = false } = {}) {
  const jobsPath = resolveJobsPath(cronCfg);
  if (!jobsPath) throw httpError(503, 'Nanobot cron jobs path is not configured');
  const validated = validateFullStore(store, { recomputeNext, strict: true });
  const disk = toDiskFormat(validated);
  const dir = path.dirname(jobsPath);
  fs.mkdirSync(dir, { recursive: true });

  let origStat = null;
  try {
    origStat = fs.statSync(jobsPath);
  } catch {
    try { origStat = fs.statSync(dir); } catch { /* ignore */ }
  }

  const tmp = path.join(dir, `.jobs.json.${process.pid}.${Date.now()}.tmp`);
  const text = `${JSON.stringify(disk, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, jobsPath);

  if (origStat) {
    try { fs.chownSync(jobsPath, origStat.uid, origStat.gid); } catch { /* ignore */ }
    try { fs.chmodSync(jobsPath, origStat.mode & 0o7777); } catch { /* ignore */ }
  }

  return validated;
}

function newJobId() {
  return uuidv4().replace(/-/g, '').slice(0, 8);
}

function createJobFromBody(body) {
  const t = nowMs();
  const id = newJobId();
  const draft = {
    id,
    name: body.name,
    enabled: body.enabled !== false,
    schedule: body.schedule,
    payload: body.payload || { message: '' },
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      runHistory: [],
    },
    createdAtMs: t,
    updatedAtMs: t,
    deleteAfterRun: Boolean(body.deleteAfterRun),
  };
  return normalizeJob(draft);
}

function mergeJobPatch(existing, patch) {
  const name = patch.name != null ? String(patch.name).trim() : existing.name;
  if (!name) throw httpError(400, 'Job name required');
  const enabled = patch.enabled != null ? Boolean(patch.enabled) : existing.enabled;
  const scheduleRaw = patch.schedule != null ? patch.schedule : existing.schedule;
  const payloadRaw = patch.payload != null
    ? { ...existing.payload, ...patch.payload }
    : existing.payload;
  const deleteAfterRun = patch.deleteAfterRun != null
    ? Boolean(patch.deleteAfterRun)
    : existing.deleteAfterRun;

  validateScheduleShape(scheduleRaw);
  validatePayloadShape(payloadRaw);
  const schedule = normalizeSchedule(scheduleRaw);
  const payload = normalizePayload(payloadRaw);

  const job = {
    id: existing.id,
    name,
    enabled,
    schedule,
    payload,
    state: {
      nextRunAtMs: null,
      lastRunAtMs: existing.state.lastRunAtMs,
      lastStatus: existing.state.lastStatus,
      lastError: existing.state.lastError,
      runHistory: (existing.state.runHistory || []).slice(-20),
    },
    createdAtMs: existing.createdAtMs,
    updatedAtMs: nowMs(),
    deleteAfterRun,
  };

  if (!enabled) job.state.nextRunAtMs = null;
  else {
    try {
      job.state.nextRunAtMs = computeNextRunMs(schedule, nowMs());
    } catch {
      job.state.nextRunAtMs = null;
    }
  }
  return job;
}

function isSystemJob(job) {
  return job.payload && job.payload.kind === 'system_event';
}

function discoverSources() {
  const cfg = config.nanobotCron || {};
  const explicit = cfg.sources && typeof cfg.sources === 'object' ? cfg.sources : {};
  const scanDirs = Array.isArray(cfg.scanDirs) ? cfg.scanDirs : [];
  const result = {};

  for (const [key, jobsJsonPath] of Object.entries(explicit)) {
    if (typeof jobsJsonPath === 'string' && jobsJsonPath.trim()) {
      result[key] = { label: key, jobsJsonPath: jobsJsonPath.trim() };
    }
  }

  for (const dir of scanDirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = entry.name;
      if (result[key]) continue;
      const candidate = path.join(dir, key, 'cron', 'jobs.json');
      if (fs.existsSync(candidate)) {
        result[key] = { label: key, jobsJsonPath: candidate };
      }
    }
  }

  return result;
}

function getSourceList() {
  const sources = discoverSources();
  return Object.entries(sources).map(([key, src]) => ({
    key,
    label: src.label,
    jobsJsonPath: src.jobsJsonPath,
  }));
}

function resolveSourceCfg(sourceKey) {
  const sources = discoverSources();
  const keys = Object.keys(sources);
  const key = sourceKey || keys[0] || '';
  const src = sources[key];
  if (!src) {
    throw httpError(keys.length === 0 ? 503 : 404,
      keys.length === 0 ? 'No cron sources configured' : `Unknown cron source: ${key}`);
  }
  const cfg = config.nanobotCron || {};
  return {
    jobsJsonPath: src.jobsJsonPath,
    allowedBasePaths: cfg.allowedBasePaths || [],
  };
}

module.exports = {
  httpError,
  resolveJobsPath,
  readStore,
  writeStore,
  validateFullStore,
  toDiskFormat,
  createJobFromBody,
  mergeJobPatch,
  isSystemJob,
  nowMs,
  discoverSources,
  getSourceList,
  resolveSourceCfg,
};
