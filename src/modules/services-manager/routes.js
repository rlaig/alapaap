'use strict';

const express = require('express');
const router = express.Router();
const { listServices, getStatus, controlService, getLogs } = require('./service');
const audit = require('../../core/audit-log');

router.get('/list', async (req, res, next) => {
  try {
    const services = await listServices();
    res.json(services);
  } catch (err) {
    next(err);
  }
});

router.get('/:name/status', async (req, res, next) => {
  try {
    const status = await getStatus(req.params.name);
    res.json(status);
  } catch (err) {
    if (err.name === 'CommandGuardError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

async function handleServiceAction(req, res, next) {
  try {
    const { name, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    await controlService(name, action);
    audit.log(`service_${action}`, {
      userId: req.user?.id,
      target: name,
      ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.name === 'CommandGuardError') return res.status(400).json({ error: err.message });
    next(err);
  }
}

router.post('/:name/start', (req, res, next) => { req.params.action = 'start'; handleServiceAction(req, res, next); });
router.post('/:name/stop', (req, res, next) => { req.params.action = 'stop'; handleServiceAction(req, res, next); });
router.post('/:name/restart', (req, res, next) => { req.params.action = 'restart'; handleServiceAction(req, res, next); });

router.get('/:name/logs', async (req, res, next) => {
  try {
    const lines = req.query.lines || 100;
    const logs = await getLogs(req.params.name, lines);
    res.json({ logs, count: logs.length, filtered: logs.length });
  } catch (err) {
    if (err.name === 'CommandGuardError') return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
