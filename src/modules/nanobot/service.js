'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../../../config/default');

function nanobotCfg() {
  return config.nanobotService || {};
}

function exec(bin, args, opts = {}) {
  const timeout = opts.timeout || 10000;
  const maxBuffer = opts.maxBuffer || 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

function parseElapsed(etimeStr) {
  const s = (etimeStr || '').trim();
  // formats: DD-HH:MM:SS, HH:MM:SS, MM:SS
  const parts = s.replace(/-/g, ':').split(':').map(Number);
  if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function humanUptime(secs) {
  if (!secs || secs <= 0) return '--';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function extractConfigPath(cmdline) {
  const parts = cmdline.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] === '-c' || parts[i] === '--config') && parts[i + 1]) {
      return parts[i + 1];
    }
  }
  return null;
}

function extractSubcommand(cmdline) {
  const parts = cmdline.split(/\s+/);
  const knownCmds = ['gateway', 'serve', 'agent', 'onboard', 'status', 'channels', 'plugins', 'provider'];
  for (const p of parts) {
    if (knownCmds.includes(p)) return p;
  }
  return 'unknown';
}

function resolveConfigAbsolute(configArg, cwd) {
  if (!configArg) return null;
  if (path.isAbsolute(configArg)) return configArg;
  if (cwd) return path.resolve(cwd, configArg);
  return null;
}

function readProcCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function parseConfigFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const cfg = JSON.parse(raw);
    const defaults = cfg.agents?.defaults || {};
    const channels = cfg.channels || {};

    const enabledChannels = [];
    for (const [name, ch] of Object.entries(channels)) {
      if (ch && typeof ch === 'object' && ch.enabled) {
        enabledChannels.push(name);
      }
    }

    return {
      model: defaults.model || null,
      provider: defaults.provider || null,
      maxTokens: defaults.maxTokens || null,
      contextWindow: defaults.contextWindowTokens || null,
      temperature: defaults.temperature ?? null,
      workspace: defaults.workspace || null,
      enabledChannels,
    };
  } catch {
    return null;
  }
}

async function listInstances() {
  let psOutput;
  try {
    psOutput = await exec('/usr/bin/ps', [
      'ax', '-o', 'pid,user,pcpu,rss,etime,args', '--no-headers',
    ]);
  } catch {
    return [];
  }

  const instances = [];
  const lines = psOutput.trim().split('\n');
  for (const line of lines) {
    if (!line.includes('nanobot')) continue;
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;

    const pid = parseInt(parts[0], 10);
    const user = parts[1];
    const cpu = parseFloat(parts[2]) || 0;
    const rssKb = parseInt(parts[3], 10) || 0;
    const etime = parts[4];
    const args = parts.slice(5).join(' ');

    // Only match lines where nanobot binary runs gateway, serve, or agent
    if (!(/\bnanobot\s+(gateway|serve|agent)\b/.test(args))) continue;

    const subcommand = extractSubcommand(args);
    const configArg = extractConfigPath(args);
    const cwd = readProcCwd(pid);
    const configAbsPath = resolveConfigAbsolute(configArg, cwd);
    const configName = configArg ? path.basename(configArg, '.json') : 'default';
    const parsedConfig = configAbsPath ? parseConfigFile(configAbsPath) : null;

    const uptimeSecs = parseElapsed(etime);

    instances.push({
      pid,
      user,
      subcommand,
      configName,
      configPath: configAbsPath,
      model: parsedConfig?.model || null,
      provider: parsedConfig?.provider || null,
      enabledChannels: parsedConfig?.enabledChannels || [],
      cpu: cpu.toFixed(1),
      memMb: (rssKb / 1024).toFixed(1),
      uptimeSecs,
      uptime: humanUptime(uptimeSecs),
      status: 'running',
    });
  }

  return instances;
}

async function getInstanceDetail(pid) {
  const instances = await listInstances();
  const inst = instances.find((i) => i.pid === pid);
  if (!inst) return null;

  let parsedConfig = null;
  if (inst.configPath) {
    parsedConfig = parseConfigFile(inst.configPath);
  }

  return { ...inst, config: parsedConfig };
}

async function getInstanceLogs(pid, lines = 100) {
  const n = Math.max(1, Math.min(parseInt(lines, 10) || 100, nanobotCfg().maxLogLines || 500));

  // Try to find the screen session that owns this PID
  const screenInfo = await findScreenForPid(pid);

  if (screenInfo) {
    try {
      const tmpFile = `/tmp/.alapaap-nanobot-log-${pid}-${Date.now()}`;
      const screenArgs = ['-S', screenInfo.fullName, '-X', 'hardcopy', '-h', tmpFile];

      if (screenInfo.user && screenInfo.user !== 'root') {
        await exec('/usr/bin/su', ['-', screenInfo.user, '-c', `screen ${screenArgs.join(' ')}`], { timeout: 5000 });
      } else {
        await exec('/usr/bin/screen', screenArgs, { timeout: 5000 });
      }
      await new Promise((r) => setTimeout(r, 300));
      if (fs.existsSync(tmpFile)) {
        const content = fs.readFileSync(tmpFile, 'utf8');
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        const allLines = content.split('\n').filter((l) => l.trim() !== '');
        return allLines.slice(-n).join('\n');
      }
    } catch { /* fall through */ }
  }

  // Fallback: read from /proc/<pid>/fd/1 (stdout) if accessible
  try {
    const content = await exec('/usr/bin/tail', ['-n', String(n), `/proc/${pid}/fd/1`], { timeout: 5000 });
    return content;
  } catch { /* ignore */ }

  // Last resort: journalctl for nanobot
  try {
    const content = await exec('/usr/bin/journalctl', [
      '_PID=' + String(pid), '-n', String(n), '--no-pager',
    ], { timeout: 5000 });
    if (content.trim()) return content;
  } catch { /* ignore */ }

  return '(no logs available — process may be running in a screen session without scrollback capture)';
}

async function findScreenForPid(pid) {
  try {
    // Walk the parent chain: nanobot -> bash -> screen
    const ancestors = [];
    let cur = pid;
    for (let depth = 0; depth < 5; depth++) {
      try {
        const out = await exec('/usr/bin/ps', ['-o', 'ppid=', '-p', String(cur)], { timeout: 3000 });
        const ppid = parseInt(out.trim(), 10);
        if (!ppid || ppid <= 1) break;
        ancestors.push(ppid);
        cur = ppid;
      } catch { break; }
    }

    // Get the process owner to look up their screen sessions
    let procUser;
    try {
      const out = await exec('/usr/bin/ps', ['-o', 'user=', '-p', String(pid)], { timeout: 3000 });
      procUser = out.trim();
    } catch { return null; }

    // List screen sessions for that user
    let screenOutput;
    try {
      if (procUser && procUser !== 'root') {
        screenOutput = await exec('/usr/bin/su', ['-', procUser, '-c', 'screen -ls'], { timeout: 5000 });
      } else {
        screenOutput = await exec('/usr/bin/screen', ['-ls'], { timeout: 3000 });
      }
    } catch (err) {
      screenOutput = err.stdout || '';
    }

    const screenLines = String(screenOutput).split('\n');
    for (const line of screenLines) {
      const m = line.match(/^\s+(\d+)\.(\S+)/);
      if (!m) continue;
      const screenPid = parseInt(m[1], 10);
      const screenName = m[2];
      if (ancestors.includes(screenPid)) {
        return { fullName: `${screenPid}.${screenName}`, user: procUser };
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function getNanobotStatus() {
  const nanobotBin = nanobotCfg().nanobotBin || '/home/ubuntu/.local/bin/nanobot';
  try {
    const output = await exec(nanobotBin, ['status'], { timeout: 10000 });
    return output;
  } catch {
    return null;
  }
}

async function listAvailableConfigs() {
  const configDir = nanobotCfg().configDir || '/home/ubuntu/.nanobot';
  try {
    const files = fs.readdirSync(configDir).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.bak')
    );
    return files.map((f) => {
      const absPath = path.join(configDir, f);
      const parsed = parseConfigFile(absPath);
      return {
        filename: f,
        name: path.basename(f, '.json'),
        path: absPath,
        model: parsed?.model || null,
        provider: parsed?.provider || null,
        enabledChannels: parsed?.enabledChannels || [],
      };
    });
  } catch {
    return [];
  }
}

module.exports = {
  listInstances,
  getInstanceDetail,
  getInstanceLogs,
  getNanobotStatus,
  listAvailableConfigs,
};
