'use strict';

const config = require('../../../config/default');

function db() {
  return config.tradingBot.ckDatabase || 'trading';
}

function chUrl(path = '') {
  return `http://${config.clickhouse.host}:${config.clickhouse.port}${path}`;
}

function chAuthHeaders() {
  const user = config.clickhouse.user || 'default';
  const password = config.clickhouse.password || '';
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
  };
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

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

async function getSummaryStats(days) {
  const d = clampInt(days, 1, 3650, 30);
  const sql = `
    SELECT
      count()                                         AS trade_count,
      countIf(pnl > 0)                                AS wins,
      countIf(pnl <= 0)                               AS losses,
      round(countIf(pnl > 0) / count() * 100, 1)     AS win_rate_pct,
      round(sum(pnl), 4)                              AS total_pnl,
      round(avg(pnl), 4)                              AS avg_pnl,
      round(avg(hold_duration_s) / 60, 1)             AS avg_hold_min,
      round(max(pnl), 4)                              AS best_trade,
      round(min(pnl), 4)                              AS worst_trade
    FROM ${db()}.trades
    WHERE side = 'sell' AND ts > now() - INTERVAL ${d} DAY`;
  const result = await chQuery(sql);
  return result.data?.[0] || {};
}

async function getEquityCurve(hours) {
  const h = clampInt(hours, 1, 8760, 168);
  const sql = `
    SELECT
      ts,
      equity_usdt,
      usdt_total,
      btc_total,
      btc_price,
      pnl_today,
      trades_today
    FROM ${db()}.balance_snapshots
    WHERE ts > now() - INTERVAL ${h} HOUR
    ORDER BY ts`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getDailyPnl(days) {
  const d = clampInt(days, 1, 3650, 30);
  const sql = `
    SELECT
      toDate(ts) AS day,
      count()    AS sell_count,
      round(sum(pnl), 4)                          AS daily_pnl,
      round(countIf(pnl > 0) / count() * 100, 1) AS win_rate_pct,
      round(min(pnl), 4)                          AS worst_trade,
      round(max(pnl), 4)                          AS best_trade
    FROM ${db()}.trades
    WHERE side = 'sell' AND ts > now() - INTERVAL ${d} DAY
    GROUP BY day
    ORDER BY day DESC`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getTradePairs(limit) {
  const n = clampInt(limit, 1, 200, 50);
  const sql = `
    SELECT
      b.ts            AS entry_time,
      s.ts            AS exit_time,
      b.strategy,
      b.price         AS entry_price,
      s.price         AS exit_price,
      s.pnl,
      s.exit_reason,
      s.hold_duration_s,
      b.market_regime AS entry_regime,
      b.signal_strength AS entry_strength,
      b.paper_mode
    FROM ${db()}.trades b
    INNER JOIN ${db()}.trades s ON b.trade_id = s.trade_id AND s.side = 'sell'
    WHERE b.side = 'buy'
    ORDER BY b.ts DESC
    LIMIT ${n}`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getWinRateByStrategy(days) {
  const d = clampInt(days, 1, 3650, 30);
  const sql = `
    SELECT
      strategy,
      count()                                         AS trades,
      countIf(pnl > 0)                                AS wins,
      round(countIf(pnl > 0) / count() * 100, 1)     AS win_rate_pct,
      round(sum(pnl), 4)                              AS total_pnl
    FROM ${db()}.trades
    WHERE side = 'sell' AND ts > now() - INTERVAL ${d} DAY
    GROUP BY strategy
    ORDER BY total_pnl DESC`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getWinRateByRegime() {
  const sql = `
    SELECT
      market_regime,
      count()                                         AS trades,
      round(countIf(pnl > 0) / count() * 100, 1)     AS win_rate_pct,
      round(sum(pnl), 4)                              AS total_pnl
    FROM ${db()}.trades
    WHERE side = 'sell'
    GROUP BY market_regime`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getGateBreakdown(days) {
  const d = clampInt(days, 1, 365, 7);
  const sql = `
    SELECT
      gate_result,
      count()                                          AS occurrences,
      round(count() / sum(count()) OVER () * 100, 1)  AS pct
    FROM ${db()}.signals
    WHERE signal = 'buy' AND ts > now() - INTERVAL ${d} DAY
    GROUP BY gate_result
    ORDER BY occurrences DESC`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getRecentSignals(limit) {
  const n = clampInt(limit, 1, 200, 50);
  const sql = `
    SELECT
      ts,
      symbol,
      strategy,
      signal,
      strength,
      close_price,
      market_regime,
      htf_trend,
      gate_result,
      gate_detail,
      position
    FROM ${db()}.signals
    ORDER BY ts DESC
    LIMIT ${n}`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getBotEvents(limit) {
  const n = clampInt(limit, 1, 200, 20);
  const sql = `
    SELECT
      ts,
      event_type,
      severity,
      message,
      metadata
    FROM ${db()}.bot_events
    ORDER BY ts DESC
    LIMIT ${n}`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getHoldDurationStats() {
  const sql = `
    SELECT
      if(pnl > 0, 'win', 'loss')             AS outcome,
      count()                                  AS trades,
      round(avg(hold_duration_s) / 60, 1)     AS avg_hold_min,
      round(min(hold_duration_s) / 60, 1)     AS min_hold_min,
      round(max(hold_duration_s) / 60, 1)     AS max_hold_min,
      round(avg(pnl), 4)                      AS avg_pnl
    FROM ${db()}.trades
    WHERE side = 'sell' AND hold_duration_s IS NOT NULL
    GROUP BY outcome`;
  const result = await chQuery(sql);
  return result.data || [];
}

async function getStrengthAnalysis() {
  const sql = `
    SELECT
      multiIf(
        s.signal_strength < 0.3, 'low (0-0.3)',
        s.signal_strength < 0.6, 'med (0.3-0.6)',
        'high (0.6-1.0)'
      ) AS strength_bucket,
      count()                                         AS trades,
      round(avg(s_sell.pnl), 4)                       AS avg_pnl,
      round(countIf(s_sell.pnl > 0) / count() * 100, 1) AS win_rate_pct
    FROM ${db()}.trades AS s
    INNER JOIN ${db()}.trades AS s_sell
      ON s.trade_id = s_sell.trade_id AND s_sell.side = 'sell'
    WHERE s.side = 'buy'
    GROUP BY strength_bucket
    ORDER BY strength_bucket`;
  const result = await chQuery(sql);
  return result.data || [];
}

module.exports = {
  getSummaryStats,
  getEquityCurve,
  getDailyPnl,
  getTradePairs,
  getWinRateByStrategy,
  getWinRateByRegime,
  getGateBreakdown,
  getRecentSignals,
  getBotEvents,
  getHoldDurationStats,
  getStrengthAnalysis,
};
