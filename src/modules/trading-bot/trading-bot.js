'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = require('../../../config/default');

function cfg() {
  return config.tradingBot || {};
}

function basePath() {
  return cfg().basePath || '/home/ubuntu/fleetnano/trader0/trading-bot';
}

function exec(bin, args, opts = {}) {
  const timeout = opts.timeout || 10000;
  const maxBuffer = opts.maxBuffer || 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        if (opts.allowNonZero && stdout) return resolve(stdout);
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function userExec(cmd) {
  const user = cfg().serviceUser || 'ubuntu';
  const wrapped = `XDG_RUNTIME_DIR=/run/user/$(id -u) ${cmd}`;
  return exec('/usr/bin/su', ['-', user, '-c', wrapped], { timeout: 10000, allowNonZero: true });
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tailFile(filePath, n) {
  const maxLines = cfg().maxLogLines || 500;
  const count = Math.max(1, Math.min(parseInt(n, 10) || 100, maxLines));
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-count).join('\n');
  } catch {
    return null;
  }
}

async function getStatus() {
  const statusPath = path.join(basePath(), 'data', 'status.json');
  return readJsonFile(statusPath);
}

async function getTrades() {
  const tradesPath = path.join(basePath(), 'src', 'data', 'trades.json');
  return readJsonFile(tradesPath) || [];
}

async function getLogs(lines, source) {
  const validSources = {
    trades: path.join(basePath(), 'data', 'trades.log'),
    output: path.join(basePath(), 'data', 'bot_output.log'),
  };
  const filePath = validSources[source] || validSources.trades;
  return tailFile(filePath, lines) || '(no logs available)';
}

async function getConfig() {
  const configPath = path.join(basePath(), 'config', 'paper.yaml');
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
}

async function getServiceStatus() {
  const svcName = cfg().serviceName || 'trading-bot';
  try {
    const output = await userExec(`systemctl --user show ${svcName} --no-pager`);
    const props = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        props[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return props;
  } catch {
    return null;
  }
}

async function controlService(action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) {
    throw new Error(`Action not allowed: ${action}`);
  }
  const svcName = cfg().serviceName || 'trading-bot';
  return userExec(`systemctl --user ${action} ${svcName}`);
}

async function getJournalLogs(lines) {
  const maxLines = cfg().maxLogLines || 500;
  const n = Math.max(1, Math.min(parseInt(lines, 10) || 100, maxLines));
  const svcName = cfg().serviceName || 'trading-bot';
  try {
    const output = await userExec(`journalctl --user -u ${svcName} -n ${n} --no-pager`);
    return output || '(no journal logs available)';
  } catch {
    return '(no journal logs available)';
  }
}

async function getStrategyConfig() {
  const configPath = path.join(basePath(), 'config', 'strategy.yaml');
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
}

function deepMerge(base, overlay) {
  const merged = { ...base };
  for (const [key, val] of Object.entries(overlay)) {
    if (val && typeof val === 'object' && !Array.isArray(val)
        && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = { ...merged[key], ...val };
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

async function getMergedConfig() {
  const baseCfgPath = path.join(basePath(), 'config', 'paper.yaml');
  const overlayPath = path.join(basePath(), 'config', 'strategy.yaml');
  try {
    const baseRaw = fs.readFileSync(baseCfgPath, 'utf8');
    const base = yaml.load(baseRaw) || {};

    let overlay = {};
    try {
      const overlayRaw = fs.readFileSync(overlayPath, 'utf8');
      overlay = yaml.load(overlayRaw) || {};
    } catch { /* overlay is optional */ }

    const merged = deepMerge(base, overlay);

    if (merged.exchange) {
      merged.exchange.api_key = '***';
      merged.exchange.api_secret = '***';
    }
    if (merged.clickhouse?.password_file) {
      merged.clickhouse.password_file = '***';
    }

    return merged;
  } catch {
    return null;
  }
}

// ── Profiles ────────────────────────────────────────────────

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function profilesDir() {
  return path.join(basePath(), 'config', 'profiles');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function listProfiles() {
  const dir = profilesDir();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    return files.map((f) => {
      const absPath = path.join(dir, f);
      try {
        const parsed = yaml.load(fs.readFileSync(absPath, 'utf8')) || {};
        return { name: path.basename(f, '.yaml'), config: parsed };
      } catch {
        return { name: path.basename(f, '.yaml'), config: null };
      }
    });
  } catch {
    return [];
  }
}

function getActiveProfile() {
  const stratPath = path.join(basePath(), 'config', 'strategy.yaml');
  let current;
  try {
    current = yaml.load(fs.readFileSync(stratPath, 'utf8')) || {};
  } catch {
    return null;
  }

  const { clickhouse, ...currentNoClk } = current;
  const profiles = listProfiles();
  for (const p of profiles) {
    if (!p.config) continue;
    const { clickhouse: _, ...profileNoClk } = p.config;
    if (deepEqual(currentNoClk, profileNoClk)) return p.name;
  }
  return null;
}

function applyProfile(name) {
  if (!name || !PROFILE_NAME_RE.test(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  const profilePath = path.join(profilesDir(), `${name}.yaml`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name}`);
  }

  const profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};

  const stratPath = path.join(basePath(), 'config', 'strategy.yaml');
  let current = {};
  try {
    current = yaml.load(fs.readFileSync(stratPath, 'utf8')) || {};
  } catch { /* no existing file is fine */ }

  const preserved = {};
  if (current.clickhouse) preserved.clickhouse = current.clickhouse;

  const newData = { ...profile, ...preserved };
  const tmp = stratPath + '.tmp';
  fs.writeFileSync(tmp, yaml.dump(newData, { sortKeys: false, flowLevel: -1 }));
  fs.renameSync(tmp, stratPath);

  return newData;
}

module.exports = {
  getStatus,
  getTrades,
  getLogs,
  getConfig,
  getStrategyConfig,
  getMergedConfig,
  getServiceStatus,
  controlService,
  getJournalLogs,
  listProfiles,
  getActiveProfile,
  applyProfile,
};
