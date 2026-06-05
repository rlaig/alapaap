'use strict';

const { exec: guardExec, validateServiceName, CommandGuardError } = require('../../core/command-guard');
const config = require('../../../config/default');

const SERVICES = config.receiptScannerLogs.services;
const MAX_LINES = config.commandGuard.maxLogLines;
const AUTH_DB_PATH = config.receiptScannerLogs.authDbPath;

const PYTHON_LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) \[(\w+)\] ([^:]+): (.*)$/;

const SINCE_MAP = {
  '1h': '1 hour ago',
  '6h': '6 hours ago',
  '24h': '1 day ago',
  '7d': '7 days ago',
};

async function getServiceStatuses() {
  const results = [];
  for (const name of SERVICES) {
    validateServiceName(name);
    const output = await guardExec('systemctl', ['show', name, '--no-pager']);
    const props = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
    }
    results.push({
      service: name,
      ActiveState: props.ActiveState || 'unknown',
      SubState: props.SubState || 'unknown',
      MemoryCurrent: props.MemoryCurrent || '0',
      MainPID: props.MainPID || '0',
      ExecMainStartTimestamp: props.ExecMainStartTimestamp || '',
    });
  }
  return results;
}

async function getLogs({ lines = 200, service, level, search, since } = {}) {
  const n = Math.max(1, Math.min(parseInt(lines, 10) || 200, MAX_LINES));
  const services = service ? [service] : SERVICES;

  for (const svc of services) validateServiceName(svc);

  const args = [];
  for (const svc of services) {
    args.push('-u', svc);
  }
  args.push('-n', String(n), '--no-pager', '--output=json');

  if (since && SINCE_MAP[since]) {
    args.push('--since', SINCE_MAP[since]);
  }

  const raw = await guardExec('journalctl', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });

  const entries = raw.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  const levelUpper = level ? level.toUpperCase() : null;
  const searchLower = search ? search.toLowerCase() : null;

  const logs = [];
  let filtered = 0;

  for (const entry of entries) {
    const msg = entry.MESSAGE || '';
    const unit = entry._SYSTEMD_UNIT || '';

    let parsed = null;

    if (unit.startsWith('receipt-scanner')) {
      const m = msg.match(PYTHON_LOG_RE);
      if (m) {
        parsed = {
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

    if (!parsed) {
      parsed = {
        service: unit,
        timestamp: '',
        level: null,
        logger: null,
        message: msg,
        priority: entry.PRIORITY || '6',
        ts: parseInt(entry.__REALTIME_TIMESTAMP, 10) || 0,
      };
    }

    if (levelUpper && parsed.level !== levelUpper) continue;
    if (searchLower && !parsed.message.toLowerCase().includes(searchLower)) continue;

    logs.push(parsed);
    filtered++;
  }

  return { logs, count: entries.length, filtered };
}

function getUsageStats() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(AUTH_DB_PATH, { readonly: true });

    try {
      const usage = db.prepare(`
        SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as users,
               MIN(created_at) as earliest, MAX(created_at) as latest
        FROM usage_logs
      `).get();

      const todayByAction = db.prepare(`
        SELECT action, COUNT(*) as count
        FROM usage_logs WHERE created_at >= datetime('now', '-1 day')
        GROUP BY action
      `).all();

      let todayReceipts = null;
      try {
        todayReceipts = db.prepare(`
          SELECT COUNT(*) as total, AVG(processing_time_ms) as avgTime,
                 SUM(total_amount) as totalSpend
          FROM receipts WHERE scanned_at >= datetime('now', '-1 day')
        `).get();
      } catch { /* receipts table or columns may not exist */ }

      let receiptStatusDist = [];
      try {
        receiptStatusDist = db.prepare(`
          SELECT status, COUNT(*) as count FROM receipts GROUP BY status ORDER BY count DESC
        `).all();
      } catch { /* status column may not exist */ }

      let todayCredits = null;
      try {
        todayCredits = db.prepare(`
          SELECT SUM(credits_used) as total FROM usage_logs
          WHERE created_at >= datetime('now', '-1 day')
        `).get();
      } catch { /* credits_used column may not exist */ }

      return { usageLogs: usage, todayByAction, todayReceipts, receiptStatusDist, todayCredits };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

module.exports = { getServiceStatuses, getLogs, getUsageStats };
