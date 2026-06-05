'use strict';

const express = require('express');
const router = express.Router();
const bot = require('./trading-bot');
const ck = require('./ck-queries');
const audit = require('../../core/audit-log');

router.get('/status', async (req, res, next) => {
  try {
    const status = await bot.getStatus();
    if (!status) return res.status(404).json({ error: 'Status not available' });
    res.json(status);
  } catch (err) { next(err); }
});

router.get('/trades', async (req, res, next) => {
  try {
    const trades = await bot.getTrades();
    res.json(trades);
  } catch (err) { next(err); }
});

router.get('/logs', async (req, res, next) => {
  try {
    const lines = req.query.lines || 100;
    const source = req.query.source || 'trades';
    const logs = await bot.getLogs(lines, source);
    res.json({ logs });
  } catch (err) { next(err); }
});

router.get('/config', async (req, res, next) => {
  try {
    const config = await bot.getConfig();
    if (!config) return res.status(404).json({ error: 'Config not available' });
    res.json({ config });
  } catch (err) { next(err); }
});

router.get('/config/strategy', async (req, res, next) => {
  try {
    const config = await bot.getStrategyConfig();
    if (!config) return res.status(404).json({ error: 'Strategy config not available' });
    res.json({ config });
  } catch (err) { next(err); }
});

router.get('/config/merged', async (req, res, next) => {
  try {
    const config = await bot.getMergedConfig();
    if (!config) return res.status(404).json({ error: 'Merged config not available' });
    res.json(config);
  } catch (err) { next(err); }
});

router.get('/service', async (req, res, next) => {
  try {
    const status = await bot.getServiceStatus();
    if (!status) return res.status(404).json({ error: 'Service status not available' });
    res.json(status);
  } catch (err) { next(err); }
});

router.post('/service/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    await bot.controlService(action);
    audit.log(`trading_bot_${action}`, {
      userId: req.user?.id,
      ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/journal', async (req, res, next) => {
  try {
    const lines = req.query.lines || 100;
    const logs = await bot.getJournalLogs(lines);
    res.json({ logs });
  } catch (err) { next(err); }
});

// ── Profile endpoints ──

router.get('/profiles', async (req, res, next) => {
  try {
    const profiles = bot.listProfiles().map((p) => ({
      name: p.name,
      strategy: p.config?.strategy?.name || null,
    }));
    const active = bot.getActiveProfile();
    res.json({ profiles, active });
  } catch (err) { next(err); }
});

router.post('/profiles/:name/apply', async (req, res, next) => {
  try {
    const { name } = req.params;
    bot.applyProfile(name);
    audit.log('trading_bot_profile_apply', {
      userId: req.user?.id,
      ip: req.ip,
      profile: name,
    });
    res.json({ ok: true, active: name });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('Invalid')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// ── ClickHouse dashboard endpoints ──

router.get('/ck/summary', async (req, res, next) => {
  try {
    res.json(await ck.getSummaryStats(req.query.days));
  } catch (err) { next(err); }
});

router.get('/ck/equity', async (req, res, next) => {
  try {
    res.json(await ck.getEquityCurve(req.query.hours));
  } catch (err) { next(err); }
});

router.get('/ck/daily-pnl', async (req, res, next) => {
  try {
    res.json(await ck.getDailyPnl(req.query.days));
  } catch (err) { next(err); }
});

router.get('/ck/trade-pairs', async (req, res, next) => {
  try {
    res.json(await ck.getTradePairs(req.query.limit));
  } catch (err) { next(err); }
});

router.get('/ck/win-rate-strategy', async (req, res, next) => {
  try {
    res.json(await ck.getWinRateByStrategy(req.query.days));
  } catch (err) { next(err); }
});

router.get('/ck/win-rate-regime', async (req, res, next) => {
  try {
    res.json(await ck.getWinRateByRegime());
  } catch (err) { next(err); }
});

router.get('/ck/gate-breakdown', async (req, res, next) => {
  try {
    res.json(await ck.getGateBreakdown(req.query.days));
  } catch (err) { next(err); }
});

router.get('/ck/signals', async (req, res, next) => {
  try {
    res.json(await ck.getRecentSignals(req.query.limit));
  } catch (err) { next(err); }
});

router.get('/ck/events', async (req, res, next) => {
  try {
    res.json(await ck.getBotEvents(req.query.limit));
  } catch (err) { next(err); }
});

router.get('/ck/hold-duration', async (req, res, next) => {
  try {
    res.json(await ck.getHoldDurationStats());
  } catch (err) { next(err); }
});

router.get('/ck/strength-analysis', async (req, res, next) => {
  try {
    res.json(await ck.getStrengthAnalysis());
  } catch (err) { next(err); }
});

module.exports = router;
