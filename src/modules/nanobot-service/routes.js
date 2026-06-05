'use strict';

const express = require('express');
const router = express.Router();
const nanobot = require('./nanobot');

router.get('/instances', async (req, res, next) => {
  try {
    const instances = await nanobot.listInstances();
    res.json(instances);
  } catch (err) { next(err); }
});

router.get('/instances/:pid/detail', async (req, res, next) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Invalid PID' });
    }
    const detail = await nanobot.getInstanceDetail(pid);
    if (!detail) return res.status(404).json({ error: 'Instance not found' });
    res.json(detail);
  } catch (err) { next(err); }
});

router.get('/instances/:pid/logs', async (req, res, next) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return res.status(400).json({ error: 'Invalid PID' });
    }
    const lines = req.query.lines || 100;
    const logs = await nanobot.getInstanceLogs(pid, lines);
    res.json({ logs });
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    const status = await nanobot.getNanobotStatus();
    res.json({ status });
  } catch (err) { next(err); }
});

router.get('/configs', async (req, res, next) => {
  try {
    const configs = await nanobot.listAvailableConfigs();
    res.json(configs);
  } catch (err) { next(err); }
});

module.exports = router;
