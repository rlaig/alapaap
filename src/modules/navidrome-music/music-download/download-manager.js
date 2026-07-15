'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { v4: uuid } = require('uuid');

let config = {};
const downloads = new Map();
const PYTHON = '/home/ubuntu/.nanobot/workspace/services/nanobot-tools/.venv/bin/python3';
const CLI_SCRIPT = path.join(__dirname, 'music-download-cli.py');

function configure(cfg) {
  config = cfg || {};
}

function getDownloadPath() {
  return config.downloadPath || '/path/navidrome/music/ytdl';
}

/**
 * Build env vars for the Python subprocess.
 */
function envWithConfig(extra = {}) {
  return {
    ...process.env,
    ...extra,
    DOWNLOAD_PATH: config.downloadPath || '/path/navidrome/music/ytdl',
    FIREFOX_PROFILE: config.firefoxProfile || '',
    NODE_PATH: config.nodePath || '/home/linuxbrew/.linuxbrew/bin/node',
  };
}

/**
 * Run a short-lived CLI command and return parsed JSON result.
 * Used for search, library, delete.
 */
function runCommand(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [CLI_SCRIPT, ...args], {
      env: envWithConfig(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Command timed out'));
    }, timeoutMs || 30000);

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      clearTimeout(timer);
      // Parse the last JSON line as the result
      const lines = stdout.trim().split('\n').filter(Boolean);
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'result') {
            result = parsed;
            break;
          }
        } catch { /* skip */ }
      }
      if (result) {
        resolve(result);
      } else {
        reject(new Error(stderr.trim() || 'No result from CLI'));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Start a download. Spawns the CLI, parses progress JSON lines,
 * and calls onProgress for each one. Returns a downloadId.
 */
function startDownload(query, onProgress) {
  const downloadId = uuid();
  const record = { id: downloadId, query, status: 'starting', percent: 0, stage: '', startedAt: Date.now() };
  downloads.set(downloadId, record);

  const child = spawn(PYTHON, [CLI_SCRIPT, 'download', query], {
    env: envWithConfig(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  const timeout = (config.downloadTimeoutMs || 300000);

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    record.status = 'failed';
    record.error = 'Download timed out';
    if (onProgress) onProgress({ downloadId, status: 'failed', stage: 'failed', percent: 0, error: 'Download timed out' });
  }, timeout);

  child.stdout.on('data', (data) => {
    stdout += data;
    const lines = stdout.split('\n');
    // Keep incomplete last line in stdout buffer
    stdout = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'progress') {
          record.percent = parsed.percent || 0;
          record.stage = parsed.stage || '';
          record.title = parsed.title || '';
          if (parsed.percent >= 100) record.status = 'completed';
          if (onProgress) onProgress({ downloadId, ...parsed });
        } else if (parsed.type === 'result') {
          if (parsed.success) {
            record.status = 'completed';
            record.result = parsed.data;
            if (onProgress) onProgress({ downloadId, status: 'completed', percent: 100, stage: 'completed', data: parsed.data });
          } else {
            record.status = 'failed';
            record.error = parsed.error;
            if (onProgress) onProgress({ downloadId, status: 'failed', stage: 'failed', percent: 0, error: parsed.error });
          }
        }
      } catch { /* skip */ }
    }
  });

  let stderrOutput = '';
  child.stderr.on('data', (data) => {
    stderrOutput += data;
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    // Parse any remaining stdout
    if (stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.type === 'progress') {
          record.percent = parsed.percent || 0;
          record.stage = parsed.stage || '';
          if (onProgress) onProgress({ downloadId, ...parsed });
        } else if (parsed.type === 'result') {
          if (parsed.success) {
            record.status = 'completed';
            record.result = parsed.data;
            if (onProgress) onProgress({ downloadId, status: 'completed', percent: 100, stage: 'completed', data: parsed.data });
          } else {
            record.status = 'failed';
            record.error = parsed.error;
            if (onProgress) onProgress({ downloadId, status: 'failed', stage: 'failed', percent: 0, error: parsed.error });
          }
        }
      } catch { /* skip */ }
    }
    if (record.status !== 'completed' && record.status !== 'failed') {
      if (code === 0) {
        record.status = 'completed';
        record.percent = 100;
      } else {
        record.status = 'failed';
        const errorMsg = stderrOutput.trim()
          ? `Process error (exit ${code}): ${stderrOutput.trim().split('\n').pop()}`
          : `Process exited with code ${code}`;
        record.error = errorMsg;
        if (onProgress) onProgress({ downloadId, status: 'failed', stage: 'failed', percent: 0, error: errorMsg });
      }
    }
    // Auto-cleanup after 1 hour
    setTimeout(() => { downloads.delete(downloadId); }, 3600000).unref();
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    record.status = 'failed';
    record.error = err.message;
    if (onProgress) onProgress({ downloadId, status: 'failed', stage: 'failed', percent: 0, error: err.message });
  });

  record.child = child;
  return downloadId;
}

function getDownloadStatus(downloadId) {
  const d = downloads.get(downloadId);
  if (!d) return null;
  return {
    id: d.id,
    query: d.query,
    status: d.status,
    percent: d.percent,
    stage: d.stage,
    title: d.title,
    error: d.error,
    result: d.result || null,
    startedAt: d.startedAt,
  };
}

function getActiveDownloads() {
  const result = [];
  for (const [id, d] of downloads) {
    if (d.status === 'starting' || d.status === 'downloading' || d.status === 'searching'
        || d.status === 'validating' || d.status === 'tagging' || d.status === 'completed') {
      result.push(getDownloadStatus(id));
    }
  }
  return result;
}

function cancelDownload(downloadId) {
  const d = downloads.get(downloadId);
  if (!d || !d.child) return false;
  d.child.kill('SIGKILL');
  d.status = 'cancelled';
  return true;
}

function destroy() {
  for (const [id, d] of downloads) {
    if (d.child && !d.child.killed) {
      d.child.kill('SIGKILL');
    }
  }
  downloads.clear();
}

module.exports = {
  configure,
  getDownloadPath,
  runCommand,
  startDownload,
  getDownloadStatus,
  getActiveDownloads,
  cancelDownload,
  destroy,
};
