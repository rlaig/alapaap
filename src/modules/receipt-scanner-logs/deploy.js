'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { broadcast } = require('../../core/websocket');
const config = require('../../../config/default');

const CHANNEL = 'receipt-scanner-logs:deploy';
const VALID_TARGETS = new Set(['all', 'frontend', 'backend', 'scan', 'auth']);
const ANSI_RE = /\x1b\[[0-9;]*m/g;

let currentDeploy = null; // { child, target, startTime, killTimer }

/**
 * Execute deploy.sh with the given target and stream output over WebSocket.
 */
function executeDeploy(target = 'all') {
  if (currentDeploy) {
    const err = new Error('Deploy already in progress');
    err.code = 409;
    throw err;
  }

  if (!VALID_TARGETS.has(target)) {
    const err = new Error('Invalid deploy target');
    err.code = 400;
    throw err;
  }

  const scriptPath = config.receiptScannerLogs.deployScript;
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    const err = new Error('Deploy script not found or not executable');
    err.code = 500;
    throw err;
  }

  const timeoutMs = config.receiptScannerLogs.deployTimeoutMs;
  const startTime = Date.now();

  broadcast(CHANNEL, { type: 'status', status: 'running', target, ts: startTime });

  const child = spawn('sudo', ['-u', 'ubuntu', 'env',
    `PATH=/home/ubuntu/.nvm/versions/node/v25.2.1/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    `HOME=/home/ubuntu`,
    scriptPath, target
  ], {
    cwd: path.dirname(scriptPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rlOut = readline.createInterface({ input: child.stdout });
  const rlErr = readline.createInterface({ input: child.stderr });

  function onLine(line) {
    const text = line.replace(ANSI_RE, '');
    broadcast(CHANNEL, { type: 'line', text, ts: Date.now() });
  }

  rlOut.on('line', onLine);
  rlErr.on('line', onLine);

  // Timeout guard
  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    broadcast(CHANNEL, { type: 'status', status: 'failed', target, ts: Date.now() });
    currentDeploy = null;
  }, timeoutMs);
  killTimer.unref?.();

  child.on('exit', (code) => {
    clearTimeout(killTimer);
    const status = code === 0 ? 'done' : 'failed';
    broadcast(CHANNEL, { type: 'status', status, target, exitCode: code, ts: Date.now() });
    currentDeploy = null;
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    broadcast(CHANNEL, { type: 'status', status: 'failed', target, error: err.message, ts: Date.now() });
    currentDeploy = null;
  });

  currentDeploy = { child, target, startTime, killTimer };
  return { started: true, target };
}

/**
 * Get current deploy status.
 */
function getStatus() {
  if (!currentDeploy) {
    return { status: 'idle', target: null, startTime: null };
  }
  return {
    status: 'running',
    target: currentDeploy.target,
    startTime: currentDeploy.startTime,
  };
}

module.exports = { executeDeploy, getStatus };
