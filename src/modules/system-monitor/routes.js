'use strict';

const express = require('express');
const router = express.Router();
const { collectAll, getProcesses } = require('./collectors');

router.get('/snapshot', async (req, res, next) => {
  try {
    const data = await collectAll();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/processes', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  res.json(getProcesses(limit));
});

module.exports = router;
