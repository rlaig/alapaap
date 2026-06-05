'use strict';

const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const os = require('os');
const config = require('../../../config/default');

const WELL_KNOWN = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns',
  80: 'http', 110: 'pop3', 143: 'imap', 443: 'https', 445: 'smb', 3306: 'mysql',
  5432: 'postgres', 6379: 'redis', 8123: 'clickhouse-http', 9000: 'clickhouse-native',
  27017: 'mongodb', 3389: 'rdp', 5900: 'vnc', 8080: 'http-alt', 8443: 'https-alt',
  3000: 'http-dev', 5000: 'http-alt', 5672: 'amqp', 15672: 'rabbitmq-mgmt',
  9090: 'prometheus', 9200: 'elasticsearch',
};

function netCfg() {
  return config.networkCheck || {};
}

function allowPublicTargets() {
  return netCfg().allowPublicTargets === true;
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inCidrInt(addrInt, baseStr, bits) {
  const base = ipv4ToInt(baseStr);
  if (base === null || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (addrInt & mask) === (base & mask);
}

function isIpv4ProbeAllowed(ip, allowPublic) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  if (inCidrInt(n, '169.254.0.0', 16)) return false;
  if (n === 0) return false;
  if (inCidrInt(n, '224.0.0.0', 4)) return false;
  if (allowPublic) return true;
  if (inCidrInt(n, '127.0.0.0', 8)) return true;
  if (inCidrInt(n, '10.0.0.0', 8)) return true;
  if (inCidrInt(n, '172.16.0.0', 12)) return true;
  if (inCidrInt(n, '192.168.0.0', 16)) return true;
  return false;
}

function stripZoneId(addr) {
  const i = addr.indexOf('%');
  return i === -1 ? addr : addr.slice(0, i);
}

function isIpv6ProbeAllowed(ip, allowPublic) {
  const kind = net.isIP(ip);
  if (kind !== 6) return false;
  const a = stripZoneId(ip).toLowerCase();
  if (a.startsWith('::ffff:')) {
    const v4 = a.slice(7);
    if (net.isIP(v4) === 4) return isIpv4ProbeAllowed(v4, allowPublic);
  }
  if (a === '::1') return true;
  if (a.startsWith('fe80:')) return true;
  if (a.startsWith('fc') || a.startsWith('fd')) return true;
  if (a.startsWith('ff')) return false;
  if (allowPublic) return true;
  return false;
}

function isProbeTargetAllowed(ip, allowPublic) {
  const k = net.isIP(ip);
  if (k === 4) return isIpv4ProbeAllowed(ip, allowPublic);
  if (k === 6) return isIpv6ProbeAllowed(ip, allowPublic);
  return false;
}

function validateHostname(host) {
  if (typeof host !== 'string') return 'Invalid host';
  const h = host.trim().toLowerCase();
  if (h.length < 1 || h.length > 253) return 'Invalid host length';
  if (h.startsWith('.') || h.endsWith('.')) return 'Invalid host';
  if (net.isIP(h)) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h)) {
    return 'Invalid hostname characters';
  }
  return null;
}

async function resolveAllowedAddresses(host, allowPublic) {
  const err = validateHostname(host);
  if (err) throw Object.assign(new Error(err), { status: 400 });

  let records;
  try {
    records = await dns.lookup(host.trim(), { all: true });
  } catch (e) {
    throw Object.assign(new Error(`DNS resolution failed: ${e.message}`), { status: 400 });
  }

  const seen = new Set();
  const out = [];
  for (const r of records) {
    const ip = r.address;
    if (!isProbeTargetAllowed(ip, allowPublic)) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  if (out.length === 0) {
    throw Object.assign(
      new Error(
        allowPublicTargets()
          ? 'Host resolves only to disallowed addresses (e.g. link-local/metadata)'
          : 'Host resolves to no RFC1918/localhost addresses. Set ALAPAAP_NETWORK_ALLOW_PUBLIC=1 to allow public IPs.'
      ),
      { status: 400 }
    );
  }
  return out;
}

function clampTimeout(ms) {
  const d = netCfg().defaultTcpTimeoutMs || 3000;
  const max = netCfg().maxTcpTimeoutMs || 15000;
  const n = parseInt(ms, 10);
  if (Number.isNaN(n) || n < 500) return d;
  return Math.min(n, max);
}

function serviceGuess(port) {
  return WELL_KNOWN[port] || null;
}

function tryTcp(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ port, host: ip, family: net.isIP(ip) === 6 ? 6 : 4 });
    let settled = false;

    function finish(payload) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(payload);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({ ok: true, remoteIp: ip, latencyMs: Date.now() - started });
    });
    socket.once('timeout', () => finish({ ok: false, remoteIp: ip, error: 'timeout' }));
    socket.once('error', (e) => finish({ ok: false, remoteIp: ip, error: e.code || e.message }));
  });
}

async function tcpCheckResolved(hostLabel, port, timeoutMs, ips) {
  const t = clampTimeout(timeoutMs);
  let lastErr = 'unreachable';
  for (const ip of ips) {
    const r = await tryTcp(ip, port, t);
    if (r.ok) {
      return {
        ok: true,
        host: hostLabel,
        port,
        remoteIp: r.remoteIp,
        latencyMs: r.latencyMs,
        service: serviceGuess(port),
      };
    }
    lastErr = r.error || 'failed';
  }
  return {
    ok: false,
    host: hostLabel,
    port,
    error: lastErr,
    tried: ips.length,
    service: serviceGuess(port),
  };
}

async function tcpCheck(host, port, timeoutMs) {
  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw Object.assign(new Error('Port must be an integer 1-65535'), { status: 400 });
  }
  const allowPublic = allowPublicTargets();
  const ips = await resolveAllowedAddresses(host, allowPublic);
  return tcpCheckResolved(host.trim(), port, clampTimeout(timeoutMs), ips);
}

async function tcpCheckMany(host, ports, timeoutMs) {
  const max = netCfg().maxBatchPorts || 32;
  if (!Array.isArray(ports) || ports.length === 0) {
    throw Object.assign(new Error('ports must be a non-empty array'), { status: 400 });
  }
  if (ports.length > max) {
    throw Object.assign(new Error(`At most ${max} ports per request`), { status: 400 });
  }
  const uniq = [...new Set(ports.map((p) => parseInt(p, 10)))].filter((p) => p >= 1 && p <= 65535);
  if (uniq.length === 0) {
    throw Object.assign(new Error('No valid ports'), { status: 400 });
  }
  const allowPublic = allowPublicTargets();
  const ips = await resolveAllowedAddresses(host, allowPublic);
  const t = clampTimeout(timeoutMs);
  const label = host.trim();
  const results = [];
  for (const port of uniq) {
    if (!Number.isInteger(port)) continue;
    results.push(await tcpCheckResolved(label, port, t, ips));
  }
  return { host: label, results };
}

function getOverview() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (!addrs) continue;
    for (const a of addrs) {
      list.push({
        name,
        family: a.family,
        address: a.address,
        netmask: a.netmask,
        internal: a.internal,
        mac: a.mac,
      });
    }
  }
  return { hostname: os.hostname(), interfaces: list };
}

function parseLittleEndianV4(hex8) {
  const n = parseInt(hex8, 16) >>> 0;
  return [(n & 0xff), (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.');
}

function formatProcIpv6(hex32) {
  const parts = [];
  for (let i = 0; i < 32; i += 4) {
    parts.push(hex32.slice(i, i + 4));
  }
  return parts.join(':').toLowerCase();
}

function parseLocalAddress(localField, isIpv6) {
  const [ipHex, portHex] = localField.split(':');
  if (!portHex) return null;
  const port = parseInt(portHex, 16);
  if (Number.isNaN(port)) return null;
  if (!isIpv6) {
    if (ipHex.length !== 8) return null;
    return { bind: parseLittleEndianV4(ipHex), port, family: 'IPv4' };
  }
  if (ipHex.length !== 32) return null;
  return { bind: formatProcIpv6(ipHex), port, family: 'IPv6' };
}

function readProcListeners(path, isIpv6) {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.trim().split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (parts[3] !== '0A') continue;
    const parsed = parseLocalAddress(parts[1], isIpv6);
    if (!parsed) continue;
    const key = `${parsed.family}|${parsed.bind}|${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      bind: parsed.bind,
      port: parsed.port,
      family: parsed.family,
      service: serviceGuess(parsed.port),
    });
  }
  out.sort((a, b) => a.port - b.port || String(a.bind).localeCompare(String(b.bind)));
  return out;
}

function getLocalListeners() {
  const v4 = readProcListeners('/proc/net/tcp', false);
  const v6 = readProcListeners('/proc/net/tcp6', true);
  return { listeners: [...v4, ...v6], source: 'proc' };
}

module.exports = {
  getOverview,
  getLocalListeners,
  tcpCheck,
  tcpCheckMany,
  serviceGuess,
  allowPublicTargets,
  validateHostname,
};
