'use strict';

const config = require('../../../config/default');
const { chUrl, chAuthHeaders, validateDbName } = require('./logs-ch-shared');

const SCHEMA_CACHE_TTL = 5 * 60 * 1000;
let schemaCache = null;
let schemaCacheTime = 0;

const STRING_TYPE_RE = /^(String|FixedString|LowCardinality\(String\)|Nullable\(String\)|LowCardinality\(Nullable\(String\)\))/i;
const DATE_TYPE_RE = /^(Date|DateTime|DateTime64)/i;
const NUMERIC_TYPE_RE = /^(UInt|Int|Float|Decimal|Nullable\((UInt|Int|Float|Decimal))/i;

function cfg() {
  return config.nanobotClickhouseLogs || {};
}

function fqTable() {
  const c = cfg();
  validateDbName(c.database);
  validateDbName(c.table);
  return `${c.database}.${c.table}`;
}

function escStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function chQuery(sql, timeoutMs) {
  const ms = timeoutMs || config.clickhouse.queryTimeout || 30000;
  const params = new URLSearchParams();
  params.set('default_format', 'JSON');

  const res = await fetch(`${chUrl('/')}?${params}`, {
    method: 'POST',
    headers: { ...chAuthHeaders(), 'Content-Type': 'text/plain' },
    body: sql,
    signal: AbortSignal.timeout(ms),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.split('\n')[0] || `ClickHouse error ${res.status}`);
  }

  return res.json();
}

async function getSchema() {
  const now = Date.now();
  if (schemaCache && (now - schemaCacheTime) < SCHEMA_CACHE_TTL) {
    return schemaCache;
  }

  const result = await chQuery(`DESCRIBE TABLE ${fqTable()}`);
  const columns = (result.data || []).map((r) => ({
    name: r.name,
    type: r.type,
    isString: STRING_TYPE_RE.test(r.type),
    isDate: DATE_TYPE_RE.test(r.type),
    isNumeric: NUMERIC_TYPE_RE.test(r.type),
  }));

  schemaCache = columns;
  schemaCacheTime = now;
  return columns;
}

function clearSchemaCache() {
  schemaCache = null;
  schemaCacheTime = 0;
}

function detectTimestampCol(columns) {
  const prefer = ['timestamp', 'created_at', 'event_time', 'time', 'date'];
  for (const name of prefer) {
    const col = columns.find((c) => c.name.toLowerCase() === name && c.isDate);
    if (col) return col.name;
  }
  const first = columns.find((c) => c.isDate);
  return first ? first.name : null;
}

function getSearchableColumns(columns) {
  const explicit = cfg().searchableColumns || [];
  if (explicit.length > 0) {
    return explicit
      .map((n) => {
        const col = columns.find((c) => c.name.toLowerCase() === n.toLowerCase());
        return col ? col.name : null;
      })
      .filter(Boolean);
  }
  return columns.filter((c) => c.isString).map((c) => c.name);
}

function buildTimeCondition(tsCol, timeRange) {
  const ranges = {
    '1h': 3600,
    '6h': 21600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  const seconds = ranges[timeRange];
  if (!seconds || !tsCol) return null;
  // DateTime64 columns without an explicit timezone are interpreted in the
  // server's local zone (e.g. Asia/Shanghai).  If the stored values are
  // actually UTC wall-clock strings we must compare against a UTC-based
  // "naive" timestamp so the arithmetic stays in the same frame.
  return `${tsCol} >= toDateTime64(formatDateTime(now('UTC'), '%F %T'), 3) - INTERVAL ${seconds} SECOND`;
}

async function buildWhereClause({ timeRange, search, filters } = {}) {
  const columns = await getSchema();
  const tsCol = detectTimestampCol(columns);
  const conditions = [];

  const timeCond = buildTimeCondition(tsCol, timeRange);
  if (timeCond) conditions.push(timeCond);

  if (search && typeof search === 'string' && search.trim()) {
    const searchCols = getSearchableColumns(columns);
    if (searchCols.length > 0) {
      const term = escStr(search.trim());
      const parts = searchCols.map((col) => `${col} LIKE '%${term}%'`);
      conditions.push(`(${parts.join(' OR ')})`);
    }
  }

  if (filters && typeof filters === 'object') {
    for (const [col, val] of Object.entries(filters)) {
      const colDef = columns.find((c) => c.name === col);
      if (!colDef) continue;
      if (val === '' || val == null) continue;
      conditions.push(`${col} = '${escStr(val)}'`);
    }
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', columns, tsCol };
}

async function getLogs({ limit, offset, timeRange, search, orderDir, filters }) {
  const c = cfg();
  const maxPage = c.maxPageSize || 200;
  const pageSize = Math.max(1, Math.min(parseInt(limit, 10) || c.defaultPageSize || 50, maxPage));
  const pageOffset = Math.max(0, parseInt(offset, 10) || 0);
  const dir = orderDir === 'asc' ? 'ASC' : 'DESC';

  const { where, tsCol } = await buildWhereClause({ timeRange, search, filters });
  const orderBy = tsCol ? `ORDER BY ${tsCol} ${dir}` : '';

  const countSql = `SELECT count() as total FROM ${fqTable()} ${where}`;
  const dataSql = `SELECT * FROM ${fqTable()} ${where} ${orderBy} LIMIT ${pageSize} OFFSET ${pageOffset}`;

  const [countResult, dataResult] = await Promise.all([
    chQuery(countSql),
    chQuery(dataSql),
  ]);

  const total = countResult.data?.[0]?.total ?? 0;

  return {
    data: dataResult.data || [],
    meta: dataResult.meta || [],
    total: Number(total),
    limit: pageSize,
    offset: pageOffset,
  };
}

async function getLogDetail(idValue) {
  const columns = await getSchema();

  const idCol = findCol(columns, 'id', 'trace_id', 'traceId', 'uuid', 'request_id', 'requestId', 'span_id', 'spanId');

  if (!idCol) {
    throw Object.assign(new Error('No identifiable ID column found in table schema'), { status: 400 });
  }

  const sql = `SELECT * FROM ${fqTable()} WHERE ${idCol} = '${escStr(idValue)}' LIMIT 1`;
  const result = await chQuery(sql);

  if (!result.data || result.data.length === 0) {
    throw Object.assign(new Error('Log entry not found'), { status: 404 });
  }

  return { data: result.data[0], meta: result.meta || [], idColumn: idCol };
}

function findCol(columns, ...candidates) {
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const col = columns.find((c) => c.name.toLowerCase() === lower);
    if (col) return col.name;
  }
  return null;
}

async function getStats({ timeRange, search, filters } = {}) {
  const { where, columns } = await buildWhereClause({ timeRange, search, filters });

  const aggs = ['count() as total_traces'];
  const mapping = {};

  const promptTokCol = findCol(columns, 'prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens');
  if (promptTokCol) { aggs.push(`sum(${promptTokCol}) as sum_prompt_tokens`); mapping.promptTokens = true; }

  const complTokCol = findCol(columns, 'completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens');
  if (complTokCol) { aggs.push(`sum(${complTokCol}) as sum_completion_tokens`); mapping.completionTokens = true; }

  const totalTokCol = findCol(columns, 'total_tokens', 'totalTokens', 'tokens');
  if (totalTokCol) { aggs.push(`sum(${totalTokCol}) as sum_total_tokens`); mapping.totalTokens = true; }

  const costCol = findCol(columns, 'total_cost', 'totalCost', 'cost');
  if (costCol) { aggs.push(`sum(${costCol}) as sum_cost`); mapping.cost = true; }

  const latencyCol = findCol(columns, 'latency_ms', 'latencyMs', 'duration_ms', 'durationMs', 'latency', 'duration');
  if (latencyCol) { aggs.push(`avg(${latencyCol}) as avg_latency`); mapping.latency = true; }

  const statusCodeCol = findCol(columns, 'status_code', 'statusCode', 'http_status');
  const statusCol = findCol(columns, 'status');
  const levelCol = findCol(columns, 'level');
  const errorCol = findCol(columns, 'error', 'error_message', 'errorMessage');
  if (statusCodeCol) {
    const colDef = columns.find((c) => c.name === statusCodeCol);
    if (colDef && colDef.isNumeric) {
      aggs.push(`countIf(${statusCodeCol} >= 400) as error_count`);
    } else {
      aggs.push(`countIf(lower(${statusCodeCol}) = 'error') as error_count`);
    }
    mapping.errors = true;
  } else if (statusCol) {
    const colDef = columns.find((c) => c.name === statusCol);
    if (colDef && colDef.isString) {
      aggs.push(`countIf(lower(${statusCol}) = 'error') as error_count`);
    } else if (colDef && colDef.isNumeric) {
      aggs.push(`countIf(${statusCol} >= 400) as error_count`);
    }
    mapping.errors = true;
  } else if (levelCol) {
    aggs.push(`countIf(lower(${levelCol}) = 'error') as error_count`);
    mapping.errors = true;
  } else if (errorCol) {
    aggs.push(`countIf(${errorCol} != '' AND ${errorCol} IS NOT NULL) as error_count`);
    mapping.errors = true;
  }

  const sql = `SELECT ${aggs.join(', ')} FROM ${fqTable()} ${where}`;
  const result = await chQuery(sql);
  const row = result.data?.[0] || {};

  const num = (v) => Number(v ?? 0);

  const promptTokens = mapping.promptTokens ? num(row.sum_prompt_tokens) : 0;
  const completionTokens = mapping.completionTokens ? num(row.sum_completion_tokens) : 0;
  const totalTokens = mapping.totalTokens
    ? num(row.sum_total_tokens)
    : (promptTokens + completionTokens) || 0;

  const stats = {
    totalTraces: num(row.total_traces),
    promptTokens,
    completionTokens,
    totalTokens,
    totalCost: mapping.cost ? num(row.sum_cost) : 0,
    avgLatencyMs: mapping.latency && row.avg_latency != null ? Number(Number(row.avg_latency).toFixed(1)) : null,
    errorCount: mapping.errors ? num(row.error_count) : 0,
    hasTokenData: !!(mapping.promptTokens || mapping.completionTokens || mapping.totalTokens),
    hasCostData: !!mapping.cost,
    hasErrorData: !!mapping.errors,
  };

  if (stats.totalTraces > 0 && mapping.errors) {
    stats.errorRate = Number(((stats.errorCount / stats.totalTraces) * 100).toFixed(2));
  } else {
    stats.errorRate = 0;
  }

  const modelCol = findCol(columns, 'model', 'modelId', 'model_id');
  if (modelCol) {
    const modelSql = `SELECT ${modelCol} as model, count() as cnt FROM ${fqTable()} ${where} GROUP BY ${modelCol} ORDER BY cnt DESC LIMIT 10`;
    try {
      const modelResult = await chQuery(modelSql);
      stats.topModels = (modelResult.data || []).map((r) => ({ model: r.model, count: Number(r.cnt) }));
    } catch {
      stats.topModels = [];
    }
  }

  return stats;
}

module.exports = { getSchema, getLogs, getLogDetail, getStats, clearSchemaCache, detectTimestampCol };
