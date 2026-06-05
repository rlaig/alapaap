'use strict';

const express = require('express');
const router = express.Router();
const docker = require('./docker');
const audit = require('../../core/audit-log');

router.get('/containers', async (req, res, next) => {
  try {
    const all = req.query.all === 'true';
    const containers = await docker.listContainers(all);
    res.json(containers);
  } catch (err) { next(err); }
});

router.get('/containers/:id', async (req, res, next) => {
  try {
    const data = await docker.inspectContainer(req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

async function handleContainerAction(req, res, next) {
  try {
    const { id, action } = req.params;
    if (action === 'start') await docker.startContainer(id);
    else if (action === 'stop') await docker.stopContainer(id);
    else if (action === 'restart') await docker.restartContainer(id);
    else return res.status(400).json({ error: 'Invalid action' });

    audit.log(`container_${action}`, {
      userId: req.user?.id,
      target: id,
      ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

router.post('/containers/:id/start', (req, res, next) => { req.params.action = 'start'; handleContainerAction(req, res, next); });
router.post('/containers/:id/stop', (req, res, next) => { req.params.action = 'stop'; handleContainerAction(req, res, next); });
router.post('/containers/:id/restart', (req, res, next) => { req.params.action = 'restart'; handleContainerAction(req, res, next); });

router.post('/containers/:id/remove', async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    await docker.removeContainer(req.params.id, force);
    audit.log('container_remove', {
      userId: req.user?.id,
      target: req.params.id,
      ip: req.ip,
      details: { force },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/containers/:id/logs', async (req, res, next) => {
  try {
    const tail = req.query.tail || 100;
    const logs = await docker.containerLogs(req.params.id, tail);
    res.json({ logs });
  } catch (err) { next(err); }
});

router.get('/images', async (req, res, next) => {
  try {
    const images = await docker.listImages();
    res.json(images);
  } catch (err) { next(err); }
});

router.get('/info', async (req, res, next) => {
  try {
    const info = await docker.getSystemInfo();
    res.json(info);
  } catch (err) { next(err); }
});

module.exports = router;
