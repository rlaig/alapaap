'use strict';

const config = require('../../../config/default');

const DB_NAME_RE = /^[a-zA-Z0-9_]+$/;

const DANGEROUS_KEYWORDS = [
  'DROP', 'TRUNCATE', 'ALTER', 'DELETE', 'INSERT', 'CREATE',
  'RENAME', 'DETACH', 'ATTACH', 'KILL', 'GRANT', 'REVOKE',
];

const ALLOWED_LEADING = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXISTS|EXPLAIN|WITH)\b/i;

class QueryValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'QueryValidationError'; }
}

function validateQuery(sql) {
  if (!sql || typeof sql !== 'string') {
    throw new QueryValidationError('Query is required');
  }

  const trimmed = sql.trim();
  if (!trimmed) throw new QueryValidationError('Query is empty');

  if (!ALLOWED_LEADING.test(trimmed)) {
    throw new QueryValidationError('Only SELECT, SHOW, DESCRIBE, EXISTS, EXPLAIN, WITH queries are allowed');
  }

  for (const kw of DANGEROUS_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(trimmed)) {
      throw new QueryValidationError(`Forbidden keyword: ${kw}`);
    }
  }

  const withoutStrings = trimmed.replace(/'[^']*'/g, '');
  if (/;\s*\S/.test(withoutStrings)) {
    throw new QueryValidationError('Multi-statement queries are not allowed');
  }

  if (!/\bLIMIT\b/i.test(trimmed)) {
    return trimmed.replace(/;?\s*$/, '') + ` LIMIT ${config.clickhouse.maxResultLimit}`;
  }

  return trimmed;
}

function validateDbName(name) {
  if (!name || !DB_NAME_RE.test(name)) {
    throw new QueryValidationError(`Invalid database/table name: ${name}`);
  }
}

function chUrl(path = '') {
  return `http://${config.clickhouse.host}:${config.clickhouse.port}${path}`;
}

/** Prefer Basic auth so credentials are not in query strings (proxies, access logs). */
function chAuthHeaders() {
  const user = config.clickhouse.user || 'default';
  const password = config.clickhouse.password || '';
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
  };
}

async function ping() {
  try {
    const res = await fetch(chUrl('/ping'), {
      signal: AbortSignal.timeout(5000),
      headers: chAuthHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function query(sql) {
  const validatedSql = validateQuery(sql);
  const params = new URLSearchParams();
  params.set('default_format', 'JSON');

  const url = `${chUrl('/')}?${params}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...chAuthHeaders(), 'Content-Type': 'text/plain' },
    body: validatedSql,
    signal: AbortSignal.timeout(config.clickhouse.queryTimeout),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.split('\n')[0] || `ClickHouse error ${res.status}`);
  }

  return res.json();
}

/**
 * Run DDL/mutation SQL built only from validated identifiers (retention module).
 * Not exposed to arbitrary user SQL.
 */
async function execMutation(sql, timeoutMs) {
  const ms = timeoutMs || config.clickhouse.queryTimeout;
  const res = await fetch(chUrl('/'), {
    method: 'POST',
    headers: { ...chAuthHeaders(), 'Content-Type': 'text/plain' },
    body: sql,
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text.split('\n')[0] || `ClickHouse error ${res.status}`);
  }
  return text;
}

async function getServerInfo() {
  const alive = await ping();
  if (!alive) return { alive: false };

  try {
    const params = new URLSearchParams();
    params.set('query', 'SELECT version() as version');
    params.set('default_format', 'JSON');
    const res = await fetch(`${chUrl('/')}?${params}`, {
      signal: AbortSignal.timeout(5000),
      headers: chAuthHeaders(),
    });
    const data = await res.json();
    const version = data.data?.[0]?.version || 'unknown';
    return { alive: true, version };
  } catch {
    return { alive: true, version: 'unknown' };
  }
}

async function getDatabases() {
  const params = new URLSearchParams();
  params.set('query', 'SHOW DATABASES');
  params.set('default_format', 'JSON');
  const res = await fetch(`${chUrl('/')}?${params}`, {
    signal: AbortSignal.timeout(5000),
    headers: chAuthHeaders(),
  });
  const data = await res.json();
  return (data.data || []).map(r => r.name);
}

async function getTables(db) {
  validateDbName(db);
  const params = new URLSearchParams();
  params.set('query', `SHOW TABLES FROM ${db}`);
  params.set('default_format', 'JSON');
  const res = await fetch(`${chUrl('/')}?${params}`, {
    signal: AbortSignal.timeout(5000),
    headers: chAuthHeaders(),
  });
  const data = await res.json();
  return (data.data || []).map(r => r.name);
}

async function getTableInfo(db, table) {
  validateDbName(db);
  validateDbName(table);
  const params = new URLSearchParams();
  params.set('query', `DESCRIBE TABLE ${db}.${table}`);
  params.set('default_format', 'JSON');
  const res = await fetch(`${chUrl('/')}?${params}`, {
    signal: AbortSignal.timeout(5000),
    headers: chAuthHeaders(),
  });
  return res.json();
}

async function getMetrics() {
  try {
    const queries = [
      "SELECT value FROM system.metrics WHERE metric = 'Query'",
      "SELECT value FROM system.metrics WHERE metric = 'TCPConnection'",
      "SELECT value FROM system.asynchronous_metrics WHERE metric = 'TotalBytesOfMergeTreeTables'",
      "SELECT value FROM system.metrics WHERE metric = 'Merge'",
    ];

    const results = await Promise.allSettled(
      queries.map(async (q) => {
        const p = new URLSearchParams();
        p.set('default_format', 'JSON');
        p.set('query', q);
        const r = await fetch(`${chUrl('/')}?${p}`, {
          signal: AbortSignal.timeout(5000),
          headers: chAuthHeaders(),
        });
        const d = await r.json();
        return d.data?.[0]?.value ?? null;
      })
    );

    return {
      queries: results[0].status === 'fulfilled' ? results[0].value : null,
      connections: results[1].status === 'fulfilled' ? results[1].value : null,
      memoryUsage: results[2].status === 'fulfilled' ? formatBytes(results[2].value) : null,
      merges: results[3].status === 'fulfilled' ? results[3].value : null,
    };
  } catch {
    return {};
  }
}

async function getQueryLog(limit = 50) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const params = new URLSearchParams();
  params.set('query', `SELECT event_time, query, query_duration_ms, read_rows FROM system.query_log WHERE type = 'QueryFinish' ORDER BY event_time DESC LIMIT ${n}`);
  params.set('default_format', 'JSON');
  try {
    const res = await fetch(`${chUrl('/')}?${params}`, {
      signal: AbortSignal.timeout(10000),
      headers: chAuthHeaders(),
    });
    const data = await res.json();
    return data.data || [];
  } catch {
    return [];
  }
}

function formatBytes(b) {
  if (b == null) return null;
  const num = Number(b);
  if (isNaN(num)) return String(b);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = num;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = {
  ping, query, execMutation, getServerInfo, getDatabases, getTables, getTableInfo,
  getMetrics, getQueryLog, validateQuery, QueryValidationError, validateDbName,
};
