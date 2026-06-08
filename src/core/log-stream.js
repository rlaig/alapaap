'use strict';

const { spawn: spawnGuarded, validateServiceName } = require('./command-guard');
const { broadcast } = require('./websocket');
const readline = require('readline');
const http = require('http');
const config = require('../../config/default');

const PYTHON_LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) \[(\w+)\] ([^:]+): (.*)$/;

/**
 * Create a managed log stream that tails a log source and broadcasts
 * parsed entries over WebSocket.
 *
 * Supported sources:
 *   - 'journalctl': tails journalctl -f for given systemd services
 *   - 'docker': tails docker logs via Docker Engine API (Unix socket)
 *
 * @param {Object} opts
 * @param {string} opts.channel - WebSocket channel to broadcast on
 * @param {string[]} opts.services - Service names or container IDs
 * @param {'journalctl'|'docker'} [opts.source='journalctl'] - Log source type
 * @param {RegExp} [opts.parser] - Optional regex for structured log parsing
 * @returns {{ start, stop, isRunning }}
 */
function createLogStream({ channel, services, source = 'journalctl', parser = PYTHON_LOG_RE }) {
  let child = null;       // journalctl child process
  let httpReq = null;     // docker HTTP request
  let respawnTimer = null;
  let backoffMs = 1000;
  const MAX_BACKOFF = 30000;
  let _isRunning = false;

  function start() {
    if (_isRunning) return;
    _isRunning = true;
    spawnStream();
  }

  function spawnStream() {
    if (!_isRunning) return;

    try {
      if (source === 'journalctl') {
        spawnJournalctl();
      } else if (source === 'docker') {
        spawnDockerStream();
      } else {
        console.error(`[log-stream] Unknown source: ${source}`);
      }
    } catch (err) {
      console.error(`[log-stream:${channel}] Spawn error: ${err.message}`);
      scheduleRespawn();
    }
  }

  // ─── journalctl source ───

  function spawnJournalctl() {
    for (const svc of services) validateServiceName(svc);
    const args = ['-f', '--output=json', '--no-pager'];
    for (const svc of services) args.push('-u', svc);
    child = spawnGuarded('journalctl', args);

    const rl = readline.createInterface({ input: child.stdout });
    const defaultService = services.length === 1 ? services[0] : '';

    rl.on('line', (line) => {
      try {
        const entry = parseLine(line, parser, defaultService);
        if (entry) broadcast(channel, entry);
      } catch { /* skip unparseable lines */ }
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[log-stream:${channel}] stderr: ${msg}`);
    });

    child.on('error', (err) => {
      console.error(`[log-stream:${channel}] Process error: ${err.message}`);
      scheduleRespawn();
    });

    child.on('exit', (code, signal) => {
      if (!_isRunning) return;
      console.warn(`[log-stream:${channel}] Exited (code=${code}, signal=${signal})`);
      scheduleRespawn();
    });

    backoffMs = 1000;
    console.log(`[log-stream:${channel}] Started journalctl (services=${services.join(',')})`);
  }

  // ─── docker source (Unix socket streaming) ───

  function spawnDockerStream() {
    if (services.length === 0) return;

    const containerId = services[0];
    const socketPath = config.docker?.socketPath || '/var/run/docker.sock';

    const opts = {
      socketPath,
      path: `/containers/${containerId}/logs?stdout=true&stderr=true&follow=true&tail=0&timestamps=true`,
      method: 'GET',
      timeout: 0, // no timeout — streaming
    };

    httpReq = http.request(opts, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          console.error(`[log-stream:${channel}] Docker API ${res.statusCode}: ${Buffer.concat(chunks).toString().trim()}`);
          scheduleRespawn();
        });
        return;
      }

      // Docker multiplexes stdout/stderr with 8-byte headers; strip them
      const rl = readline.createInterface({ input: res });
      const defaultService = containerId;

      rl.on('line', (line) => {
        try {
          // Strip Docker multiplex header bytes (null + stream type byte + 4-byte length)
          const cleaned = line.replace(/[\x00-\x08]/g, '');
          if (!cleaned.trim()) return;
          const entry = parseDockerLine(cleaned, defaultService);
          if (entry) broadcast(channel, entry);
        } catch { /* skip */ }
      });

      res.on('error', (err) => {
        console.error(`[log-stream:${channel}] Docker stream error: ${err.message}`);
        scheduleRespawn();
      });

      res.on('close', () => {
        if (!_isRunning) return;
        console.warn(`[log-stream:${channel}] Docker stream closed`);
        scheduleRespawn();
      });
    });

    httpReq.on('error', (err) => {
      console.error(`[log-stream:${channel}] Docker request error: ${err.message}`);
      scheduleRespawn();
    });

    httpReq.end();
    backoffMs = 1000;
    console.log(`[log-stream:${channel}] Started docker stream (container=${containerId})`);
  }

  // ─── lifecycle ───

  function scheduleRespawn() {
    if (!_isRunning) return;
    if (respawnTimer) clearTimeout(respawnTimer);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      spawnStream();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    respawnTimer.unref?.();
  }

  function stop() {
    _isRunning = false;
    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      child = null;
    }
    if (httpReq) {
      try { httpReq.destroy(); } catch { /* ignore */ }
      httpReq = null;
    }
  }

  return {
    start,
    stop,
    get isRunning() { return _isRunning; },
  };
}

/**
 * Parse a journalctl JSON line into a normalized entry.
 */
function parseLine(line, parser, defaultService) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const entry = JSON.parse(trimmed);
    const msg = entry.MESSAGE || '';
    const unit = entry._SYSTEMD_UNIT || '';

    if (parser && unit.startsWith('receipt-scanner')) {
      const m = msg.match(parser);
      if (m) {
        return {
          service: unit,
          timestamp: m[1],
          level: m[2],
          logger: m[3],
          message: m[4],
          priority: entry.PRIORITY || '6',
          ts: parseInt(entry.__REALTIME_TIMESTAMP, 10) || 0,
        };
      }
    }

    return {
      service: unit,
      timestamp: '',
      level: null,
      logger: null,
      message: msg,
      priority: entry.PRIORITY || '6',
      ts: parseInt(entry.__REALTIME_TIMESTAMP, 10) || 0,
    };
  } catch {
    return {
      service: defaultService || '',
      timestamp: '',
      level: null,
      logger: null,
      message: trimmed,
      priority: '6',
      ts: 0,
    };
  }
}

/**
 * Parse a Docker log line (text with optional timestamp prefix).
 */
function parseDockerLine(line, defaultService) {
  if (!line || !line.trim()) return null;

  // Docker --timestamps format: "2024-01-15T12:00:00.000000000Z message"
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+(.*)/);
  if (tsMatch) {
    return {
      service: defaultService,
      timestamp: tsMatch[1].replace(/\.\d+Z?$/, ''),
      level: null,
      logger: null,
      message: tsMatch[2],
      priority: '6',
      ts: new Date(tsMatch[1]).getTime() || 0,
    };
  }

  return {
    service: defaultService,
    timestamp: '',
    level: null,
    logger: null,
    message: line,
    priority: '6',
    ts: 0,
  };
}

module.exports = { createLogStream, PYTHON_LOG_RE };
