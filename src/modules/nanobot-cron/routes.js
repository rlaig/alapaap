'use strict';

const express = require('express');
const audit = require('../../core/audit-log');
const {
  readStore,
  writeStore,
  createJobFromBody,
  mergeJobPatch,
  isSystemJob,
  getSourceList,
  resolveSourceCfg,
} = require('./store');

const router = express.Router();

function cronCfgForReq(req) {
  return resolveSourceCfg(req.query.source || '');
}

function sourceKeyForReq(req) {
  const list = getSourceList();
  const requested = (req.query.source || '').trim();
  if (requested) return requested;
  return list.length > 0 ? list[0].key : '';
}

router.get('/sources', (_req, res) => {
  res.json({ sources: getSourceList() });
});

router.get('/status', (req, res, next) => {
  try {
    const cfg = cronCfgForReq(req);
    const source = sourceKeyForReq(req);
    const { configured, path: resolved, store } = readStore(cfg);
    res.json({
      configured,
      source,
      path: resolved,
      jobCount: store ? store.jobs.length : 0,
      parseErrorCount: store ? (store.parseErrors || []).length : 0,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/store', (req, res, next) => {
  try {
    const cfg = cronCfgForReq(req);
    const { configured, path: p, store } = readStore(cfg);
    if (!configured) {
      return res.status(503).json({ error: 'Nanobot cron jobs path is not configured' });
    }
    res.json({ path: p, ...store, parseErrors: store.parseErrors || [] });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/store', (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    const cfg = cronCfgForReq(req);
    const source = sourceKeyForReq(req);
    const { configured, path: p } = readStore(cfg);
    if (!configured || !p) {
      return res.status(503).json({ error: 'Nanobot cron jobs path is not configured' });
    }
    const incoming = { version: body.version, jobs: body.jobs };
    writeStore(cfg, incoming, { recomputeNext: true });
    audit.log('nanobot_cron_store_replace', {
      userId: req.user?.id,
      target: p,
      ip: req.ip,
      details: { source, jobs: incoming.jobs?.length },
    });
    const fresh = readStore(cfg);
    res.json({ ok: true, path: fresh.path, ...fresh.store });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/jobs', (req, res, next) => {
  try {
    const cfg = cronCfgForReq(req);
    const source = sourceKeyForReq(req);
    const { configured, store } = readStore(cfg);
    if (!configured) {
      return res.status(503).json({ error: 'Nanobot cron jobs path is not configured' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (body.payload && body.payload.kind === 'system_event') {
      return res.status(400).json({ error: 'Cannot create system_event jobs via the dashboard' });
    }
    const job = createJobFromBody(body);
    store.jobs.push(job);
    writeStore(cfg, store, { recomputeNext: false });
    audit.log('nanobot_cron_job_add', {
      userId: req.user?.id,
      target: job.id,
      ip: req.ip,
      details: { source },
    });
    res.status(201).json({ ok: true, job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch('/jobs/:id', (req, res, next) => {
  try {
    const cfg = cronCfgForReq(req);
    const source = sourceKeyForReq(req);
    const { configured, store } = readStore(cfg);
    if (!configured) {
      return res.status(503).json({ error: 'Nanobot cron jobs path is not configured' });
    }
    const id = String(req.params.id || '').trim();
    const idx = store.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Job not found' });
    const existing = store.jobs[idx];
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (isSystemJob(existing)) {
      if (patch.payload && patch.payload.kind && patch.payload.kind !== 'system_event') {
        return res.status(400).json({ error: 'System job payload.kind cannot be changed' });
      }
    } else if (patch.payload && patch.payload.kind === 'system_event') {
      return res.status(400).json({ error: 'Cannot turn a user job into a system job' });
    }
    const job = mergeJobPatch(existing, patch);
    store.jobs[idx] = job;
    writeStore(cfg, store, { recomputeNext: false });
    audit.log('nanobot_cron_job_patch', {
      userId: req.user?.id,
      target: id,
      ip: req.ip,
      details: { source },
    });
    res.json({ ok: true, job });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/jobs/:id', (req, res, next) => {
  try {
    const cfg = cronCfgForReq(req);
    const source = sourceKeyForReq(req);
    const { configured, store } = readStore(cfg);
    if (!configured) {
      return res.status(503).json({ error: 'Nanobot cron jobs path is not configured' });
    }
    const id = String(req.params.id || '').trim();
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (isSystemJob(job)) {
      return res.status(403).json({ error: 'Cannot delete system-managed cron job (payload.kind is system_event)' });
    }
    store.jobs = store.jobs.filter((j) => j.id !== id);
    writeStore(cfg, store, { recomputeNext: false });
    audit.log('nanobot_cron_job_delete', {
      userId: req.user?.id,
      target: id,
      ip: req.ip,
      details: { source },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
