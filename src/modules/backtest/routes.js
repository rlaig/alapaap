'use strict';

const express = require('express');
const router = express.Router();
const bt = require('./backtest');
const jobs = require('./job-manager');
const audit = require('../../core/audit-log');

// ── Strategies ──

router.get('/strategies', (req, res) => {
  res.json(bt.getAvailableStrategies());
});

router.get('/profiles', (req, res) => {
  res.json(bt.getAvailableProfiles());
});

// ── Historical Data ──

router.get('/historical-info', (req, res) => {
  res.json(bt.getHistoricalDataInfo());
});

router.post('/historical/download', (req, res, next) => {
  try {
    const { timeframes, start } = req.body;
    if (!timeframes || !start) {
      return res.status(400).json({ error: 'timeframes and start are required' });
    }
    const tfList = String(timeframes).split(',').map((s) => s.trim()).filter(Boolean);
    const invalid = tfList.filter((tf) => !bt.ALL_TIMEFRAMES.includes(tf));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid timeframes: ${invalid.join(', ')}` });
    }
    if (!/^\d{4}-\d{2}$/.test(start)) {
      return res.status(400).json({ error: 'start must be YYYY-MM format' });
    }

    const tfStr = tfList.join(',');
    const label = `Download ${tfStr} from ${start}`;
    const child = bt.spawnDownloadHistorical(tfStr, start);
    const job = jobs.createJob('download', label, child);

    audit.log('backtest_download_start', {
      userId: req.user?.id, ip: req.ip, timeframes: tfStr, start,
    });

    res.json({ jobId: job.id });
  } catch (err) {
    if (err.message.includes('already running')) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/historical/update', (req, res, next) => {
  try {
    const { timeframes } = req.body;
    if (!timeframes) {
      return res.status(400).json({ error: 'timeframes is required' });
    }
    const tfList = String(timeframes).split(',').map((s) => s.trim()).filter(Boolean);
    const invalid = tfList.filter((tf) => !bt.ALL_TIMEFRAMES.includes(tf));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid timeframes: ${invalid.join(', ')}` });
    }

    const tfStr = tfList.join(',');
    const label = `Update ${tfStr} to present`;
    const child = bt.spawnUpdateHistorical(tfStr);
    const job = jobs.createJob('update', label, child);

    audit.log('backtest_update_start', {
      userId: req.user?.id, ip: req.ip, timeframes: tfStr,
    });

    res.json({ jobId: job.id });
  } catch (err) {
    if (err.message.includes('already running')) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// ── Run Backtest ──

router.post('/run', (req, res, next) => {
  try {
    const { strategy, timeframe, start, end, capital, params, profile } = req.body;
    if (!strategy || !start || !end) {
      return res.status(400).json({ error: 'strategy, start, and end are required' });
    }

    const tf = timeframe || '15m';
    const cap = Number(capital) || 10000;
    const profileTag = profile ? ` [${profile}]` : '';
    const label = `${strategy.toUpperCase()} / ${tf} / ${start} to ${end}${profileTag}`;
    const child = bt.spawnBacktest({ strategy, timeframe: tf, start, end, capital: cap, params, profile: profile || null });
    const job = jobs.createJob('backtest', label, child);

    audit.log('backtest_run_start', {
      userId: req.user?.id, ip: req.ip, strategy, timeframe: tf, start, end, capital: cap, profile: profile || null,
    });

    res.json({ jobId: job.id });
  } catch (err) {
    if (err.message.includes('already running')) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// ── Jobs ──

router.get('/jobs', (req, res) => {
  res.json(jobs.getJobs());
});

router.get('/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.post('/jobs/:id/cancel', (req, res) => {
  const ok = jobs.cancelJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Job not found or not running' });
  audit.log('backtest_job_cancel', { userId: req.user?.id, ip: req.ip, jobId: req.params.id });
  res.json({ ok: true });
});

// ── Runs ──

router.get('/runs', (req, res, next) => {
  try {
    res.json(bt.listRuns());
  } catch (err) { next(err); }
});

router.get('/runs/:name/metrics', (req, res) => {
  const data = bt.getRunMetrics(req.params.name);
  if (!data) return res.status(404).json({ error: 'Run not found' });
  res.json(data);
});

router.get('/runs/:name/trades', (req, res) => {
  const data = bt.getRunTrades(req.params.name);
  res.json(data);
});

router.get('/runs/:name/equity', (req, res) => {
  const data = bt.getRunEquity(req.params.name);
  res.json(data);
});

router.get('/runs/:name/report', (req, res) => {
  const data = bt.getRunReport(req.params.name);
  if (!data) return res.status(404).json({ error: 'Report not found' });
  res.json({ report: data });
});

router.delete('/runs/:name', (req, res) => {
  const ok = bt.deleteRun(req.params.name);
  if (!ok) return res.status(404).json({ error: 'Run not found' });
  audit.log('backtest_run_delete', { userId: req.user?.id, ip: req.ip, run: req.params.name });
  res.json({ ok: true });
});

// ── Compare ──

router.post('/compare', (req, res) => {
  const { runs } = req.body;
  if (!Array.isArray(runs) || runs.length < 2) {
    return res.status(400).json({ error: 'At least 2 run names required' });
  }
  res.json(bt.compareRuns(runs));
});

module.exports = router;
