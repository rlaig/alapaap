'use strict';

const config = require('../../../config/default');
const ch = require('./clickhouse');

const TAG = '[ch-maintenance]';

const SYSTEM_LOG_TABLES = [
  { table: 'query_log',               dateCol: 'event_date' },
  { table: 'query_thread_log',        dateCol: 'event_date' },
  { table: 'trace_log',               dateCol: 'event_date' },
  { table: 'text_log',                dateCol: 'event_date' },
  { table: 'metric_log',              dateCol: 'event_date' },
  { table: 'part_log',                dateCol: 'event_date' },
  { table: 'asynchronous_metric_log', dateCol: 'event_date' },
];

let schedulerHandle = null;
let lastRunResult = null;
let lastRunTime = null;
let running = false;

function opts() {
  const m = (config.clickhouse && config.clickhouse.maintenance) || {};
  return {
    enabled:                   m.enabled !== false,
    intervalMs:                Number.isFinite(m.intervalMs) ? m.intervalMs : 86400000,
    systemLogTTLDays:          Number.isFinite(m.systemLogTTLDays) ? m.systemLogTTLDays : 7,
    maxInactivePartsPerTable:  Number.isFinite(m.maxInactivePartsPerTable) ? m.maxInactivePartsPerTable : 500,
    maxPartsPerTable:          Number.isFinite(m.maxPartsPerTable) ? m.maxPartsPerTable : 3000,
    staleMutationMinutes:      Number.isFinite(m.staleMutationMinutes) ? m.staleMutationMinutes : 120,
  };
}

// ---------------------------------------------------------------------------
// 1. System log table TTL enforcement
// ---------------------------------------------------------------------------

async function getExistingSystemTables() {
  const sql = `
    SELECT name FROM system.tables
    WHERE database = 'system' AND engine LIKE '%MergeTree%'
  `.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  return new Set((r.data || []).map((row) => row.name));
}

async function getTableTTL(db, table) {
  const sql = `
    SELECT engine_full FROM system.tables
    WHERE database = '${db}' AND name = '${table}'
    LIMIT 1
  `.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  const ef = r.data?.[0]?.engine_full || '';
  return /\bTTL\b/i.test(ef);
}

async function enforceSystemLogTTLs(force = false) {
  const o = opts();
  const days = o.systemLogTTLDays;
  const existing = await getExistingSystemTables();
  const results = [];

  for (const { table, dateCol } of SYSTEM_LOG_TABLES) {
    if (!existing.has(table)) {
      results.push({ table, status: 'skipped', reason: 'table does not exist' });
      continue;
    }
    try {
      const hasTTL = await getTableTTL('system', table);
      if (hasTTL && !force) {
        results.push({ table, status: 'skipped', reason: 'TTL already set' });
        continue;
      }
      const sql = `ALTER TABLE system.${table} MODIFY TTL ${dateCol} + INTERVAL ${days} DAY`;
      await ch.execMutation(sql, 30000);
      results.push({ table, status: 'applied', ttl: `${dateCol} + ${days}d` });
    } catch (err) {
      results.push({ table, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. Inactive parts cleanup
// ---------------------------------------------------------------------------

async function getInactiveParts() {
  const sql = `
    SELECT database, table, count() AS inactive_parts,
      sum(bytes_on_disk) AS inactive_bytes
    FROM system.parts
    WHERE active = 0
    GROUP BY database, table
    ORDER BY inactive_parts DESC
    LIMIT 200
  `.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  return r.data || [];
}

async function cleanupInactiveParts() {
  const o = opts();
  const rows = await getInactiveParts();
  const results = [];

  for (const row of rows) {
    if (Number(row.inactive_parts) < o.maxInactivePartsPerTable) continue;
    try {
      const sql = `OPTIMIZE TABLE \`${row.database}\`.\`${row.table}\``;
      await ch.execMutation(sql, 60000);
      results.push({ database: row.database, table: row.table, inactiveParts: Number(row.inactive_parts), status: 'optimized' });
    } catch (err) {
      results.push({ database: row.database, table: row.table, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 3. Detached parts audit (diagnostic only)
// ---------------------------------------------------------------------------

async function getDetachedParts() {
  const sql = `
    SELECT database, table, count() AS cnt,
      sum(bytes_on_disk) AS total_bytes,
      groupArray(reason) AS reasons
    FROM system.detached_parts
    GROUP BY database, table
    ORDER BY cnt DESC
    LIMIT 200
  `.replace(/\s+/g, ' ').trim();
  try {
    const r = await ch.query(sql);
    return r.data || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. Stale mutations (diagnostic + on-demand kill)
// ---------------------------------------------------------------------------

async function getStaleMutations() {
  const o = opts();
  const sql = `
    SELECT database, table, mutation_id, command,
      create_time, parts_to_do, is_done
    FROM system.mutations
    WHERE is_done = 0
      AND create_time < now() - INTERVAL ${o.staleMutationMinutes} MINUTE
    ORDER BY create_time ASC
    LIMIT 100
  `.replace(/\s+/g, ' ').trim();
  try {
    const r = await ch.query(sql);
    return r.data || [];
  } catch {
    return [];
  }
}

async function killMutation(database, table, mutationId) {
  ch.validateDbName(database);
  ch.validateDbName(table);
  if (!mutationId || typeof mutationId !== 'string' || mutationId.length > 256) {
    throw Object.assign(new Error('Invalid mutation_id'), { status: 400 });
  }
  const escaped = mutationId.replace(/'/g, "\\'");
  const sql = `KILL MUTATION WHERE database = '${database}' AND table = '${table}' AND mutation_id = '${escaped}'`;
  const text = await ch.execMutation(sql, 30000);
  return { database, table, mutationId, response: text.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// 5. Table optimization (high part-count tables)
// ---------------------------------------------------------------------------

async function getHighPartCountTables() {
  const o = opts();
  const sql = `
    SELECT database, table, count() AS active_parts,
      sum(bytes_on_disk) AS total_bytes
    FROM system.parts
    WHERE active = 1
    GROUP BY database, table
    HAVING active_parts > ${Math.floor(o.maxPartsPerTable / 2)}
    ORDER BY active_parts DESC
    LIMIT 200
  `.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  return r.data || [];
}

async function optimizeHighPartTables() {
  const o = opts();
  const rows = await getHighPartCountTables();
  const results = [];

  for (const row of rows) {
    if (Number(row.active_parts) < o.maxPartsPerTable) continue;
    try {
      const sql = `OPTIMIZE TABLE \`${row.database}\`.\`${row.table}\``;
      await ch.execMutation(sql, 60000);
      results.push({ database: row.database, table: row.table, activeParts: Number(row.active_parts), status: 'optimized' });
    } catch (err) {
      results.push({ database: row.database, table: row.table, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 6. Cache flush (on-demand only)
// ---------------------------------------------------------------------------

async function flushCaches() {
  const results = [];
  for (const cmd of ['SYSTEM DROP MARK CACHE', 'SYSTEM DROP UNCOMPRESSED CACHE']) {
    try {
      await ch.execMutation(cmd, 15000);
      results.push({ command: cmd, status: 'ok' });
    } catch (err) {
      results.push({ command: cmd, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Full maintenance cycle
// ---------------------------------------------------------------------------

async function runMaintenanceCycle(force = false) {
  if (running) {
    return { skipped: true, reason: 'cycle already in progress' };
  }
  running = true;
  const startMs = Date.now();

  try {
    const alive = await ch.ping();
    if (!alive) {
      const result = { ok: false, error: 'ClickHouse unreachable', durationMs: Date.now() - startMs, ts: new Date().toISOString() };
      lastRunResult = result;
      lastRunTime = Date.now();
      return result;
    }

    const [ttlResults, inactiveResults, optimizeResults] = await Promise.all([
      enforceSystemLogTTLs(force).catch((e) => [{ status: 'error', error: e.message }]),
      cleanupInactiveParts().catch((e) => [{ status: 'error', error: e.message }]),
      optimizeHighPartTables().catch((e) => [{ status: 'error', error: e.message }]),
    ]);

    const result = {
      ok: true,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      systemLogTTL: ttlResults,
      inactivePartsCleanup: inactiveResults,
      tableOptimization: optimizeResults,
    };

    lastRunResult = result;
    lastRunTime = Date.now();
    console.log(`${TAG} cycle complete in ${result.durationMs}ms – TTL:${ttlResults.length} inactive:${inactiveResults.length} optimize:${optimizeResults.length}`);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message, durationMs: Date.now() - startMs, ts: new Date().toISOString() };
    lastRunResult = result;
    lastRunTime = Date.now();
    console.error(`${TAG} cycle error:`, err.message);
    return result;
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics (read-only aggregate)
// ---------------------------------------------------------------------------

async function getDiagnostics() {
  const [inactiveParts, detachedParts, staleMutations, highPartTables] = await Promise.all([
    getInactiveParts().catch(() => []),
    getDetachedParts().catch(() => []),
    getStaleMutations().catch(() => []),
    getHighPartCountTables().catch(() => []),
  ]);
  return { inactiveParts, detachedParts, staleMutations, highPartTables };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function start() {
  const o = opts();
  if (!o.enabled) {
    console.log(`${TAG} disabled via config`);
    return;
  }
  stop();

  const delay = Math.max(60000, Math.min(o.intervalMs, 7 * 86400000));
  console.log(`${TAG} scheduler started – interval ${Math.round(delay / 60000)}m`);

  const initialDelay = Math.min(delay, 60000);
  setTimeout(() => {
    runMaintenanceCycle().catch((e) => console.error(`${TAG} initial run error:`, e.message));
  }, initialDelay);

  schedulerHandle = setInterval(() => {
    runMaintenanceCycle().catch((e) => console.error(`${TAG} scheduled run error:`, e.message));
  }, delay);
}

function stop() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

function getStatus() {
  const o = opts();
  return {
    enabled: o.enabled,
    intervalMs: o.intervalMs,
    running,
    lastRun: lastRunResult,
    lastRunTime: lastRunTime ? new Date(lastRunTime).toISOString() : null,
    nextRunApprox: lastRunTime ? new Date(lastRunTime + o.intervalMs).toISOString() : null,
    config: o,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  runMaintenanceCycle,
  getDiagnostics,
  flushCaches,
  killMutation,
  enforceSystemLogTTLs,
};
