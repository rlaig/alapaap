'use strict';

const config = require('../../../config/default');
const ch = require('./clickhouse');

function retentionOpts() {
  const r = (config.clickhouse && config.clickhouse.retention) || {};
  const deny = new Set(
    (r.denyDatabases || ['system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables']).map((x) =>
      String(x).toLowerCase()
    )
  );
  const allowed = (r.allowedDatabases || []).map((x) => String(x).trim()).filter(Boolean);
  return {
    denyDatabases: deny,
    allowedDatabases: allowed.length ? new Set(allowed.map((d) => d.toLowerCase())) : null,
    maxAlterDeleteRows: Number.isFinite(r.maxAlterDeleteRows) ? r.maxAlterDeleteRows : 50_000_000,
    maxPartitionsPerRequest: Number.isFinite(r.maxPartitionsPerRequest) ? r.maxPartitionsPerRequest : 500,
    mutationTimeoutMs: Number.isFinite(r.mutationTimeoutMs) ? r.mutationTimeoutMs : 120000,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function assertDbTable(db, table) {
  ch.validateDbName(db);
  ch.validateDbName(table);
  const ro = retentionOpts();
  const dl = String(db).toLowerCase();
  if (ro.denyDatabases.has(dl)) throw httpError(400, `Database "${db}" is denied for retention`);
  if (ro.allowedDatabases && !ro.allowedDatabases.has(dl)) {
    throw httpError(400, `Database "${db}" is not in ALAPAAP_CH_RETENTION_ALLOWED_DBS allowlist`);
  }
}

function assertColumn(name) {
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw httpError(400, 'Invalid column name');
  }
}

function quoteIdent(name) {
  assertColumn(name);
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function escapePartitionLiteral(partition) {
  const p = String(partition);
  if (p.length > 512) throw httpError(400, 'Partition id too long');
  return p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function classifyTimeType(describeType) {
  let t = String(describeType || '').toLowerCase().trim();
  const nullM = t.match(/^nullable\((.*)\)$/);
  if (nullM) t = nullM[1].trim();
  const lcM = t.match(/^lowcardinality\((.*)\)$/);
  if (lcM) t = lcM[1].trim();
  if (t.startsWith('datetime64') || t.startsWith('datetime')) return 'DateTime';
  if (t.startsWith('date32') || t.startsWith('date')) return 'Date';
  return null;
}

function suggestTimeColumns(describeRows) {
  const data = describeRows?.data || [];
  const hints = ['time', 'ts', 'timestamp', 'created_at', 'event_time', 'date', 'dt', 'day'];
  const out = [];
  for (const row of data) {
    const name = row.name;
    const kind = classifyTimeType(row.type);
    if (!kind) continue;
    let score = 1;
    const nl = String(name).toLowerCase();
    if (hints.some((h) => nl.includes(h))) score += 2;
    out.push({ name, type: row.type, kind, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function getStorageOverview() {
  const ro = retentionOpts();
  let dbFilter = '';
  if (ro.allowedDatabases && ro.allowedDatabases.size > 0) {
    const list = [...ro.allowedDatabases].map((d) => `'${d.replace(/'/g, "''")}'`).join(', ');
    dbFilter = `AND database IN (${list})`;
  }
  const denyList = [...ro.denyDatabases].map((d) => `'${d.replace(/'/g, "''")}'`).join(', ');
  const sql = `
    SELECT database, name, engine, total_rows, total_bytes,
      partition_key,
      formatReadableSize(total_bytes) AS readable_size
    FROM system.tables
    WHERE database NOT IN (${denyList})
    ${dbFilter}
    ORDER BY total_bytes DESC
    LIMIT 500
  `.replace(/\s+/g, ' ').trim();
  return ch.query(sql);
}

async function getTableEngineRow(db, table) {
  assertDbTable(db, table);
  const sql = `
    SELECT engine, engine_full, total_rows, total_bytes, partition_key
    FROM system.tables
    WHERE database = '${db.replace(/'/g, "''")}' AND name = '${table.replace(/'/g, "''")}'
    LIMIT 1
  `.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  return r.data?.[0] || null;
}

function extractTtlSnippet(engineFull, createQuery) {
  const ef = String(engineFull || '');
  const ttlM = ef.match(/\bTTL\b[\s\S]+?(?=\s+(?:SETTINGS|PRIMARY|ORDER|SAMPLE|TTL\b)|$)/i);
  if (ttlM) return ttlM[0].trim().slice(0, 800);
  const cq = String(createQuery || '');
  const m2 = cq.match(/\bTTL\b[\s\S]+?(?=\s*(?:SETTINGS|PRIMARY|ORDER|ENGINE)|$)/i);
  return m2 ? m2[0].trim().slice(0, 800) : null;
}

async function getRetentionTableMeta(db, table) {
  assertDbTable(db, table);
  const [engineRow, describe, createRow] = await Promise.all([
    getTableEngineRow(db, table),
    ch.getTableInfo(db, table),
    ch.query(`
      SELECT create_table_query
      FROM system.tables
      WHERE database = '${db.replace(/'/g, "''")}' AND name = '${table.replace(/'/g, "''")}'
      LIMIT 1
    `.replace(/\s+/g, ' ').trim()),
  ]);
  const createQuery = createRow.data?.[0]?.create_table_query || '';
  const engine = engineRow?.engine || '';
  const mergeTree = /MergeTree/i.test(engine) && !/^Distributed$/i.test(engine);
  const distributed = /^Distributed$/i.test(engine);
  return {
    database: db,
    name: table,
    engine,
    engine_full: engineRow?.engine_full || '',
    partition_key: engineRow?.partition_key || '',
    total_rows: engineRow?.total_rows ?? null,
    total_bytes: engineRow?.total_bytes ?? null,
    ttl: extractTtlSnippet(engineRow?.engine_full, createQuery),
    create_table_query: createQuery.length > 2000 ? `${createQuery.slice(0, 2000)}…` : createQuery,
    timeColumns: suggestTimeColumns(describe),
    supportsPartitionDrop: mergeTree && !distributed,
    distributed,
  };
}

async function listEligiblePartitions(db, table, olderThanDays) {
  assertDbTable(db, table);
  const days = parseInt(olderThanDays, 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw httpError(400, 'olderThanDays must be between 1 and 3650');
  }
  const sql = `
    SELECT partition,
      sum(rows) AS rows,
      sum(bytes_on_disk) AS bytes_on_disk,
      max(max_date) AS max_part_date,
      min(min_date) AS min_part_date
    FROM system.parts
    WHERE database = '${db.replace(/'/g, "''")}' AND table = '${table.replace(/'/g, "''")}' AND active
    GROUP BY partition
    HAVING max_part_date < subtractDays(today(), ${days})
    ORDER BY partition
    LIMIT 10000
  `.replace(/\s+/g, ' ').trim();
  try {
    const r = await ch.query(sql);
    return r.data || [];
  } catch (e) {
    throw httpError(400, `Partition scan failed (table may not be MergeTree/parts-based): ${e.message}`);
  }
}

function countWhereClause(column, kind, days) {
  const qc = quoteIdent(column);
  if (kind === 'Date') {
    return `${qc} < subtractDays(today(), ${days})`;
  }
  return `${qc} < now() - INTERVAL ${days} DAY`;
}

async function countRowsToDelete(db, table, column, kind, days) {
  assertDbTable(db, table);
  assertColumn(column);
  const d = parseInt(days, 10);
  if (!Number.isFinite(d) || d < 1 || d > 3650) throw httpError(400, 'olderThanDays must be between 1 and 3650');
  const where = countWhereClause(column, kind, d);
  const sql = `SELECT count() AS cnt FROM \`${db}\`.\`${table}\` WHERE ${where}`.replace(/\s+/g, ' ').trim();
  const r = await ch.query(sql);
  const cnt = r.data?.[0]?.cnt;
  return Number(cnt) || 0;
}

async function previewRetention({ database, table, column, olderThanDays }) {
  assertDbTable(database, table);
  const meta = await getRetentionTableMeta(database, table);
  const describe = await ch.getTableInfo(database, table);
  const colRow = (describe.data || []).find((r) => r.name === column);
  if (!colRow) throw httpError(400, 'Column not found');
  const kind = classifyTimeType(colRow.type);
  if (!kind) throw httpError(400, 'Column must be Date, DateTime, or DateTime64');

  const days = parseInt(olderThanDays, 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw httpError(400, 'olderThanDays must be between 1 and 3650');
  }

  let partitions = [];
  let partitionNote = null;
  if (meta.supportsPartitionDrop) {
    try {
      partitions = await listEligiblePartitions(database, table, days);
      const ro = retentionOpts();
      if (partitions.length > ro.maxPartitionsPerRequest) {
        partitionNote = `Showing first ${ro.maxPartitionsPerRequest} of ${partitions.length} eligible partitions; narrow retention or raise maxPartitionsPerRequest`;
        partitions = partitions.slice(0, ro.maxPartitionsPerRequest);
      }
    } catch (e) {
      partitionNote = e.message;
      partitions = [];
    }
  } else if (meta.distributed) {
    partitionNote = 'Distributed engine: use ALTER DELETE on this table or target local tables; partition drop is skipped.';
  } else {
    partitionNote = 'Non–MergeTree / no part-based partition drop; use ALTER DELETE only.';
  }

  const alterDeleteCount = await countRowsToDelete(database, table, column, kind, days);
  const partitionBytes = partitions.reduce((s, p) => s + (Number(p.bytes_on_disk) || 0), 0);
  const partitionRows = partitions.reduce((s, p) => s + (Number(p.rows) || 0), 0);

  return {
    meta,
    column,
    columnType: colRow.type,
    timeKind: kind,
    olderThanDays: days,
    alterDelete: { rowCount: alterDeleteCount },
    partitions: {
      eligible: partitions,
      totalBytes: partitionBytes,
      totalRows: partitionRows,
      note: partitionNote,
    },
  };
}

function formatDropPartitionClause(partition) {
  const p = String(partition).trim();
  if (p.startsWith('(')) return p;
  return `'${escapePartitionLiteral(p)}'`;
}

async function executeDropPartitions(database, table, olderThanDays, partitionIds) {
  assertDbTable(database, table);
  const meta = await getRetentionTableMeta(database, table);
  if (!meta.supportsPartitionDrop) {
    throw httpError(400, 'This table does not support partition drop via this tool');
  }
  const days = parseInt(olderThanDays, 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw httpError(400, 'olderThanDays must be between 1 and 3650');
  }
  const eligible = await listEligiblePartitions(database, table, days);
  const eligibleSet = new Set(eligible.map((r) => r.partition));
  const ro = retentionOpts();
  const ids = Array.isArray(partitionIds) ? partitionIds : [];
  if (ids.length === 0) throw httpError(400, 'No partitions selected');
  if (ids.length > ro.maxPartitionsPerRequest) {
    throw httpError(400, `At most ${ro.maxPartitionsPerRequest} partitions per request`);
  }
  for (const id of ids) {
    if (!eligibleSet.has(id)) {
      throw httpError(400, `Partition "${String(id).slice(0, 80)}" is not eligible (re-run preview)`);
    }
  }

  const results = [];
  for (const id of ids) {
    const clause = formatDropPartitionClause(id);
    const sql = `ALTER TABLE \`${database}\`.\`${table}\` DROP PARTITION ${clause}`;
    const text = await ch.execMutation(sql, ro.mutationTimeoutMs);
    results.push({ partition: id, ok: true, response: text.slice(0, 200) });
  }
  return { action: 'drop_partitions', dropped: results.length, results };
}

async function executeAlterDelete(database, table, column, olderThanDays) {
  assertDbTable(database, table);
  const describe = await ch.getTableInfo(database, table);
  const colRow = (describe.data || []).find((r) => r.name === column);
  if (!colRow) throw httpError(400, 'Column not found');
  const kind = classifyTimeType(colRow.type);
  if (!kind) throw httpError(400, 'Column must be Date, DateTime, or DateTime64');

  const days = parseInt(olderThanDays, 10);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw httpError(400, 'olderThanDays must be between 1 and 3650');
  }

  const cnt = await countRowsToDelete(database, table, column, kind, days);
  const ro = retentionOpts();
  if (cnt > ro.maxAlterDeleteRows) {
    throw httpError(
      400,
      `Refusing ALTER DELETE: ${cnt} rows exceed maxAlterDeleteRows (${ro.maxAlterDeleteRows})`
    );
  }
  if (cnt === 0) {
    return { action: 'alter_delete', rowsTargeted: 0, skipped: true, response: 'No matching rows; no mutation sent.' };
  }
  const where = countWhereClause(column, kind, days);
  const sql = `ALTER TABLE \`${database}\`.\`${table}\` DELETE WHERE ${where}`;
  const text = await ch.execMutation(sql, ro.mutationTimeoutMs);
  return { action: 'alter_delete', rowsTargeted: cnt, response: text.slice(0, 300) };
}

async function executeRetention(body) {
  const confirm = body?.confirm;
  if (confirm !== 'DELETE OLD DATA') {
    throw httpError(400, 'Set confirm to the exact string DELETE OLD DATA');
  }
  const action = body?.action;
  const database = body?.database;
  const table = body?.table;
  assertDbTable(database, table);

  if (action === 'drop_partitions') {
    const partitions = body?.partitions;
    const olderThanDays = body?.olderThanDays;
    if (olderThanDays == null || olderThanDays === '') {
      throw httpError(400, 'olderThanDays required for drop_partitions');
    }
    if (!Array.isArray(partitions) || partitions.length === 0) {
      throw httpError(400, 'partitions array required');
    }
    return executeDropPartitions(database, table, olderThanDays, partitions);
  }

  if (action === 'alter_delete') {
    const column = body?.column;
    const olderThanDays = body?.olderThanDays;
    assertColumn(column);
    return executeAlterDelete(database, table, column, olderThanDays);
  }

  throw httpError(400, 'action must be drop_partitions or alter_delete');
}

module.exports = {
  getStorageOverview,
  getRetentionTableMeta,
  previewRetention,
  executeRetention,
};
