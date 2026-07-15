'use strict';

const express = require('express');
const router = express.Router();
const docker = require('./docker');
const audit = require('../../core/audit-log');
const { broadcast } = require('../../core/websocket');
const config = require('../../../config/default');

// Coerce a request body into Docker Engine's filter shape: an object whose
// values are arrays of strings. Unknown / non-boolean scalar values are dropped
// to keep this safe for any client input. Used by the prune routes to forward
// optional filters (e.g. `dangling: false`) to Docker.
function sanitizePruneFilters(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === true || v === false) out[k] = [String(v)];
    else if (typeof v === 'string') out[k] = [v];
    else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
      out[k] = v.map(String);
    }
  }
  return out;
}

// ─── Containers ───

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
    else if (action === 'pause') await docker.pauseContainer(id);
    else if (action === 'unpause') await docker.unpauseContainer(id);
    else return res.status(400).json({ error: 'Invalid action' });

    audit.log(`container_${action}`, { userId: req.user?.id, target: id, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

router.post('/containers/:id/start', (req, res, next) => { req.params.action = 'start'; handleContainerAction(req, res, next); });
router.post('/containers/:id/stop', (req, res, next) => { req.params.action = 'stop'; handleContainerAction(req, res, next); });
router.post('/containers/:id/restart', (req, res, next) => { req.params.action = 'restart'; handleContainerAction(req, res, next); });
router.post('/containers/:id/pause', (req, res, next) => { req.params.action = 'pause'; handleContainerAction(req, res, next); });
router.post('/containers/:id/unpause', (req, res, next) => { req.params.action = 'unpause'; handleContainerAction(req, res, next); });

router.post('/containers/:id/kill', async (req, res, next) => {
  try {
    await docker.killContainer(req.params.id, req.body?.signal || 'SIGKILL');
    audit.log('container_kill', { userId: req.user?.id, target: req.params.id, ip: req.ip, details: { signal: req.body?.signal || 'SIGKILL' } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/containers/:id/rename', async (req, res, next) => {
  try {
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'Name required' });
    await docker.renameContainer(req.params.id, name);
    audit.log('container_rename', { userId: req.user?.id, target: req.params.id, ip: req.ip, details: { name } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/containers/:id/remove', async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    await docker.removeContainer(req.params.id, force);
    audit.log('container_remove', { userId: req.user?.id, target: req.params.id, ip: req.ip, details: { force } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/containers/prune', async (req, res, next) => {
  try {
    const filters = sanitizePruneFilters(req.body);
    const result = await docker.pruneContainers(filters);
    audit.log('containers_prune', { userId: req.user?.id, ip: req.ip, details: { filters } });
    res.json(result || { ok: true });
  } catch (err) { next(err); }
});

router.get('/containers/:id/logs', async (req, res, next) => {
  try {
    const tail = req.query.tail || req.query.lines || 100;
    const raw = await docker.containerLogs(req.params.id, tail);
    const lines = (raw || '').split('\n').filter(Boolean);
    const entries = lines.map(line => ({
      service: req.params.id,
      timestamp: '',
      level: null,
      logger: null,
      message: line.replace(/[\x00-\x08]/g, ''),
      priority: '6',
      ts: 0,
    }));
    res.json({ logs: entries, count: entries.length, filtered: entries.length });
  } catch (err) { next(err); }
});

router.get('/containers/:id/stats', async (req, res, next) => {
  try {
    const stats = await docker.containerStats(req.params.id);
    res.json({ raw: stats, compact: docker.compactStats(stats) });
  } catch (err) { next(err); }
});

router.get('/containers/:id/top', async (req, res, next) => {
  try {
    res.json(await docker.containerTop(req.params.id));
  } catch (err) { next(err); }
});

// ─── Images ───

router.get('/images', async (req, res, next) => {
  try {
    res.json(await docker.listImages());
  } catch (err) { next(err); }
});

router.get('/images/:ref', async (req, res, next) => {
  try {
    res.json(await docker.inspectImage(req.params.ref));
  } catch (err) { next(err); }
});

router.delete('/images/:ref', async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    const noprune = req.body?.noprune === true;
    const result = await docker.removeImage(req.params.ref, { force, noprune });
    audit.log('image_remove', { userId: req.user?.id, target: req.params.ref, ip: req.ip, details: { force, noprune } });
    res.json(result || { ok: true });
  } catch (err) { next(err); }
});

router.post('/images/prune', async (req, res, next) => {
  try {
    const filters = sanitizePruneFilters(req.body);
    const result = await docker.pruneImages(filters);
    audit.log('images_prune', { userId: req.user?.id, ip: req.ip, details: { filters } });
    res.json(result || { ok: true });
  } catch (err) { next(err); }
});

// ─── Image pull (streaming progress over WS) ───

const CHANNEL = 'docker:image-pull';
const activePulls = new Map(); // ref -> { promise, lastEmit, layers, statuses, started }

function refFromReq({ name, tag, ref }) {
  if (ref) return ref;
  return tag ? `${name}:${tag}` : name;
}

function sumLayers(layers) {
  let current = 0, total = 0, known = 0;
  for (const l of layers.values()) {
    if (typeof l.current === 'number') current += l.current;
    if (typeof l.total === 'number') { total += l.total; known++; }
  }
  return {
    current, total,
    percent: total > 0 ? Math.min(100, Math.round((current / total) * 1000) / 10) : null,
    layers: layers.size,
  };
}

function startPull(name, tag, { checkOnly = false } = {}) {
  const ref = tag ? `${name}:${tag}` : name;
  const existing = activePulls.get(ref);
  if (existing) return existing.promise;

  const state = { promise: null, lastEmit: 0, layers: new Map(), statuses: [], started: Date.now() };
  const emitMs = config.docker?.pull?.progressEmitMs ?? 150;

  function emit(extra, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - state.lastEmit < emitMs) return;
    state.lastEmit = now;
    broadcast(CHANNEL, Object.assign(
      { ref, checkOnly, layers: Array.from(state.layers.values()), summary: sumLayers(state.layers), statuses: state.statuses },
      extra
    ));
  }

  const promise = (async () => {
    emit({ event: 'start' }, { force: true });
    try {
      await docker.pullImage(name, tag, (obj) => {
        if (!obj) return;
        if (obj.error) {
          emit({ event: 'error', message: obj.error }, { force: true });
          return;
        }
        if (obj.id) {
          state.layers.set(obj.id, {
            id: obj.id,
            status: obj.status || null,
            current: obj.progressDetail?.current ?? null,
            total: obj.progressDetail?.total ?? null,
            progress: obj.progress || null,
          });
        } else if (obj.status) {
          state.statuses.push(obj.status);
        }
        if (obj.stream) state.statuses.push(obj.stream.trim());
        emit({ event: 'progress' });
      });
      // Inspect the final status lines to decide up-to-date vs updated.
      const joined = state.statuses.join('\n');
      const upToDate = /Image is up to date/i.test(joined) && !/Downloaded newer/i.test(joined);
      const updated = /Downloaded newer image|Status: Downloaded/i.test(joined);
      emit({ event: 'done', upToDate, updated, elapsedMs: Date.now() - state.started }, { force: true });
    } catch (err) {
      emit({ event: 'error', message: err.message }, { force: true });
    } finally {
      activePulls.delete(ref);
    }
  })();

  state.promise = promise;
  activePulls.set(ref, state);
  return promise;
}

router.post('/images/pull', async (req, res, next) => {
  try {
    const { name, tag } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const ref = tag ? `${name}:${tag}` : name;
    const max = config.docker?.pull?.maxConcurrent || 2;
    if (activePulls.size >= max && !activePulls.has(ref)) {
      return res.status(409).json({ error: 'Too many concurrent pulls' });
    }
    startPull(name, tag);
    audit.log('image_pull', { userId: req.user?.id, target: ref, ip: req.ip });
    res.json({ ok: true, ref });
  } catch (err) { next(err); }
});

router.post('/images/check-update', async (req, res, next) => {
  try {
    const { ref } = req.body || {};
    if (!ref) return res.status(400).json({ error: 'ref required' });
    const idx = ref.lastIndexOf(':');
    let name = ref, tag = '';
    if (idx > 0 && !ref.slice(idx + 1).includes('/')) {
      name = ref.slice(0, idx);
      tag = ref.slice(idx + 1);
    }
    if (activePulls.size >= (config.docker?.pull?.maxConcurrent || 2) && !activePulls.has(ref)) {
      return res.status(409).json({ error: 'Too many concurrent pulls' });
    }
    startPull(name, tag, { checkOnly: true });
    res.json({ ok: true, ref });
  } catch (err) { next(err); }
});

// ─── Volumes ───

router.get('/volumes', async (req, res, next) => {
  try { res.json(await docker.listVolumes()); } catch (err) { next(err); }
});
router.get('/volumes/:name', async (req, res, next) => {
  try { res.json(await docker.inspectVolume(req.params.name)); } catch (err) { next(err); }
});
router.delete('/volumes/:name', async (req, res, next) => {
  try {
    await docker.removeVolume(req.params.name, req.body?.force === true);
    audit.log('volume_remove', { userId: req.user?.id, target: req.params.name, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/volumes/prune', async (req, res, next) => {
  try {
    const filters = sanitizePruneFilters(req.body);
    const result = await docker.pruneVolumes(filters);
    audit.log('volumes_prune', { userId: req.user?.id, ip: req.ip, details: { filters } });
    res.json(result || { ok: true });
  } catch (err) { next(err); }
});

// ─── Networks ───

router.get('/networks', async (req, res, next) => {
  try { res.json(await docker.listNetworks()); } catch (err) { next(err); }
});
router.get('/networks/:id', async (req, res, next) => {
  try { res.json(await docker.inspectNetwork(req.params.id)); } catch (err) { next(err); }
});
router.delete('/networks/:id', async (req, res, next) => {
  try {
    await docker.removeNetwork(req.params.id);
    audit.log('network_remove', { userId: req.user?.id, target: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/networks/prune', async (req, res, next) => {
  try {
    const filters = sanitizePruneFilters(req.body);
    const result = await docker.pruneNetworks(filters);
    audit.log('networks_prune', { userId: req.user?.id, ip: req.ip, details: { filters } });
    res.json(result || { ok: true });
  } catch (err) { next(err); }
});

// ─── System ───

router.get('/info', async (req, res, next) => {
  try { res.json(await docker.getSystemInfo()); } catch (err) { next(err); }
});
router.get('/system/info', async (req, res, next) => {
  try { res.json(await docker.getSystemInfo()); } catch (err) { next(err); }
});
router.get('/system/df', async (req, res, next) => {
  try { res.json(await docker.systemDf()); } catch (err) { next(err); }
});

// ─── Exec config (for the terminal UI) ───

router.get('/exec/config', (req, res) => {
  const e = Object.assign({ enabled: true, defaultUser: 'root', defaultShell: '/bin/sh', allowedShells: ['/bin/sh','/bin/bash','/bin/ash','sh','bash'] }, config.docker?.exec);
  res.json({
    enabled: e.enabled !== false,
    defaultUser: e.defaultUser,
    defaultShell: e.defaultShell,
    allowedShells: e.allowedShells,
  });
});

module.exports = router;
