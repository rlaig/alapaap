'use strict';

const express = require('express');
const router = express.Router();
const queries = require('./queries');

router.get('/schema', async (req, res, next) => {
  try {
    const columns = await queries.getSchema();
    const tsCol = queries.detectTimestampCol(columns);
    res.json({ columns, timestampColumn: tsCol });
  } catch (err) {
    next(err);
  }
});

router.get('/logs', async (req, res, next) => {
  try {
    const filters = {};
    for (const [key, val] of Object.entries(req.query)) {
      const m = key.match(/^filter\[(.+)]$/);
      if (m) filters[m[1]] = val;
    }

    const result = await queries.getLogs({
      limit: req.query.limit,
      offset: req.query.offset,
      timeRange: req.query.timeRange,
      search: req.query.search,
      orderDir: req.query.orderDir,
      filters,
    });
    res.json(result);
  } catch (err) {
    if (err.name === 'QueryValidationError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/logs/:id', async (req, res, next) => {
  try {
    const result = await queries.getLogDetail(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const filters = {};
    for (const [key, val] of Object.entries(req.query)) {
      const m = key.match(/^filter\[(.+)]$/);
      if (m) filters[m[1]] = val;
    }

    const stats = await queries.getStats({
      timeRange: req.query.timeRange,
      search: req.query.search,
      filters,
    });
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
