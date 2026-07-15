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
} = require('./cron-store');

const cronRouter = express.Router();

function cronCfgForReq(req) {
  return resolveSourceCfg(req.query.source || '');
}

function sourceKeyForReq(req) {
  const list = getSourceList();
  const requested = (req.query.source || '').trim();
  if (requested) return requested;
  return list.length > 0 ? list[0].key : '';
}

cronRouter.get('/sources', (_req, res) => {
  res.json({ sources: getSourceList() });
});

cronRouter.get('/status', (req, res, next) => {
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

cronRouter.get('/store', (req, res, next) => {
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

cronRouter.put('/store', (req, res, next) => {
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

cronRouter.post('/jobs', (req, res, next) => {
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

cronRouter.patch('/jobs/:id', (req, res, next) => {
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

cronRouter.delete('/jobs/:id', (req, res, next) => {
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

/* ── Service routes ── */

const serviceRouter = express.Router();
const nanobot = require('./service');

serviceRouter.get('/instances', async (req, res, next) => {
  try {
    const instances = await nanobot.listInstances();
    res.json(instances);
  } catch (err) { next(err); }
});

serviceRouter.get('/instances/:pid/detail', async (req, res, next) => {
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

serviceRouter.get('/instances/:pid/logs', async (req, res, next) => {
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

serviceRouter.get('/status', async (req, res, next) => {
  try {
    const status = await nanobot.getNanobotStatus();
    res.json({ status });
  } catch (err) { next(err); }
});

serviceRouter.get('/configs', async (req, res, next) => {
  try {
    const configs = await nanobot.listAvailableConfigs();
    res.json(configs);
  } catch (err) { next(err); }
});

/* ── Logs routes ── */

const logsRouter = express.Router();
const queries = require('./logs-queries');

logsRouter.get('/schema', async (req, res, next) => {
  try {
    const columns = await queries.getSchema();
    const tsCol = queries.detectTimestampCol(columns);
    res.json({ columns, timestampColumn: tsCol });
  } catch (err) {
    next(err);
  }
});

logsRouter.get('/logs', async (req, res, next) => {
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

logsRouter.get('/logs/:id', async (req, res, next) => {
  try {
    const result = await queries.getLogDetail(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

logsRouter.get('/stats', async (req, res, next) => {
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

/* ── Combined router ── */

const router = express.Router();
router.use('/cron', cronRouter);
router.use('/service', serviceRouter);
router.use('/logs', logsRouter);

module.exports = router;
