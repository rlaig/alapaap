'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec: guardExec } = require('../../core/command-guard');

let prevCpuInfo = null;
let prevNetInfo = null;

function getCpuUsage() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return 0;

    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);

    if (!prevCpuInfo) {
      prevCpuInfo = { idle, total };
      return 0;
    }

    const dIdle = idle - prevCpuInfo.idle;
    const dTotal = total - prevCpuInfo.total;
    prevCpuInfo = { idle, total };

    return dTotal === 0 ? 0 : ((1 - dIdle / dTotal) * 100);
  } catch {
    return 0;
  }
}

function getMemory() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    for (const line of info.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) map[m[1]] = parseInt(m[2], 10) * 1024;
    }
    const total = map.MemTotal || 0;
    const free = (map.MemFree || 0) + (map.Buffers || 0) + (map.Cached || 0);
    const used = total - free;
    return { total, used, free, available: map.MemAvailable || free };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, free, available: free };
  }
}

async function getDisks() {
  try {
    const output = await guardExec('df', ['-BK', '--output=source,fstype,size,used,avail,pcent,target'], { timeout: 5000 });
    const lines = output.trim().split('\n').slice(1);
    return lines
      .map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) return null;
        const fstype = parts[1];
        if (['tmpfs', 'devtmpfs', 'squashfs', 'overlay'].includes(fstype)) return null;
        return {
          source: parts[0],
          fstype,
          size: formatKb(parts[2]),
          used: formatKb(parts[3]),
          avail: formatKb(parts[4]),
          percent: parts[5].replace('%', ''),
          mount: parts.slice(6).join(' '),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatKb(kbStr) {
  let kb = parseInt(kbStr, 10);
  if (isNaN(kb)) return kbStr;
  const units = ['K', 'M', 'G', 'T'];
  let i = 0;
  while (kb >= 1024 && i < units.length - 1) { kb /= 1024; i++; }
  return kb.toFixed(1) + units[i];
}

function getNetwork() {
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = data.split('\n').slice(2);
    const result = [];

    for (const line of lines) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 11) continue;
      const iface = parts[0];
      if (iface === 'lo') continue;

      const rxBytes = parseInt(parts[1], 10);
      const txBytes = parseInt(parts[9], 10);

      let rxRate = 0, txRate = 0;
      if (prevNetInfo && prevNetInfo[iface]) {
        rxRate = rxBytes - prevNetInfo[iface].rx;
        txRate = txBytes - prevNetInfo[iface].tx;
      }

      result.push({ iface, rxBytes, txBytes, rxRate, txRate });
    }

    const netMap = {};
    for (const r of result) netMap[r.iface] = { rx: r.rxBytes, tx: r.txBytes };
    prevNetInfo = netMap;

    return result;
  } catch {
    return [];
  }
}

function getProcesses(limit = 15) {
  try {
    const pids = fs.readdirSync('/proc').filter(f => /^\d+$/.test(f));
    const numCpus = os.cpus().length;
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const hz = 100;

    const procs = [];
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(path.join('/proc', pid, 'stat'), 'utf8');
        const nameMatch = stat.match(/\((.+?)\)/);
        const name = nameMatch ? nameMatch[1] : pid;

        const afterName = stat.slice(stat.lastIndexOf(')') + 2);
        const fields = afterName.split(' ');
        const utime = parseInt(fields[11], 10) || 0;
        const stime = parseInt(fields[12], 10) || 0;
        const starttime = parseInt(fields[19], 10) || 0;
        const rss = (parseInt(fields[21], 10) || 0) * 4096;

        const totalTime = utime + stime;
        const seconds = uptime - (starttime / hz);
        const cpu = seconds > 0 ? ((totalTime / hz) / seconds) * 100 / numCpus : 0;

        procs.push({ pid: parseInt(pid, 10), name, cpu, rss });
      } catch {
        continue;
      }
    }

    procs.sort((a, b) => b.cpu - a.cpu);
    return procs.slice(0, limit);
  } catch {
    return [];
  }
}

async function collectAll() {
  const [disks] = await Promise.all([getDisks()]);
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    cpu: getCpuUsage(),
    memory: getMemory(),
    disks,
    network: getNetwork(),
    processes: getProcesses(),
  };
}

module.exports = { collectAll, getCpuUsage, getMemory, getDisks, getNetwork, getProcesses };
