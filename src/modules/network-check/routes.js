'use strict';

const express = require('express');
const router = express.Router();
const audit = require('../../core/audit-log');
const netmod = require('./network');

router.get('/overview', (req, res, next) => {
  try {
    res.json(netmod.getOverview());
  } catch (err) {
    next(err);
  }
});

router.get('/listeners', (req, res, next) => {
  try {
    res.json(netmod.getLocalListeners());
  } catch (err) {
    next(err);
  }
});

router.get('/options', (req, res) => {
  res.json({ allowPublicTargets: netmod.allowPublicTargets() });
});

router.post('/tcp', async (req, res, next) => {
  try {
    const { host, port, timeoutMs } = req.body || {};
    if (typeof host !== 'string' || host.trim() === '') {
      return res.status(400).json({ error: 'host required' });
    }
    const p = parseInt(port, 10);
    if (Number.isNaN(p)) {
      return res.status(400).json({ error: 'port required' });
    }
    const r = await netmod.tcpCheck(host, p, timeoutMs);
    audit.log('network_tcp_check', {
      userId: req.user?.id,
      target: `${host.trim()}:${p}`,
      ip: req.ip,
      details: { ok: r.ok, remoteIp: r.remoteIp },
    });
    res.json(r);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/ports', async (req, res, next) => {
  try {
    const { host, ports, timeoutMs } = req.body || {};
    if (typeof host !== 'string' || host.trim() === '') {
      return res.status(400).json({ error: 'host required' });
    }
    const data = await netmod.tcpCheckMany(host, ports, timeoutMs);
    audit.log('network_port_scan', {
      userId: req.user?.id,
      target: host.trim(),
      ip: req.ip,
      details: {
        count: data.results.length,
        open: data.results.filter((x) => x.ok).length,
      },
    });
    res.json(data);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
