'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const audit = require('../../core/audit-log');
const store = require('./workspace-store');
const gitStore = require('./git-store');

const router = express.Router();

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function sourceForReq(req) {
  return store.resolveSource(req.query.source || '');
}

router.get('/sources', (_req, res) => {
  res.json({ sources: store.getSourceList() });
});

router.get('/custom-path', (req, res, next) => {
  try {
    const sourceKey = req.query.source || '';
    const custom = store.getCustomRoot(sourceKey);
    res.json({
      source: sourceKey,
      workspaceRoot: custom.workspaceRoot,
      gitRoot: custom.gitRoot,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/custom-path', (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (!body.source) {
      return res.status(400).json({ error: 'source field required' });
    }

    store.setCustomRoot(body.source, body.workspaceRoot, body.gitRoot);
    const custom = store.getCustomRoot(body.source);

    audit.log('nanobot_workspace_custom_path', {
      userId: req.user?.id,
      target: body.source,
      ip: req.ip,
      details: { workspaceRoot: body.workspaceRoot, gitRoot: body.gitRoot },
    });

    res.json({
      ok: true,
      source: body.source,
      workspaceRoot: custom.workspaceRoot,
      gitRoot: custom.gitRoot,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/browse', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const relPath = req.query.path || '';
    const result = store.browseDir(src.workspaceRoot, relPath);
    res.json({ source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/file', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const relPath = req.query.path || '';
    const result = store.readFile(src.workspaceRoot, relPath);
    res.json({ source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/raw', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const relPath = req.query.path || '';
    const meta = store.resolveFilePath(src.workspaceRoot, relPath);
    const ext = path.extname(meta.absPath).slice(1).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Content-Length', meta.size);
    res.set('Cache-Control', 'private, max-age=60');
    fs.createReadStream(meta.absPath).pipe(res);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/file', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (!body.path) {
      return res.status(400).json({ error: 'path field required' });
    }
    const result = store.createFile(src.workspaceRoot, body.path, body.content || '');
    audit.log('nanobot_workspace_file_create', {
      userId: req.user?.id,
      target: body.path,
      ip: req.ip,
      details: { source: src.key },
    });
    res.status(201).json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/file', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (!body.path) {
      return res.status(400).json({ error: 'path field required' });
    }
    const result = store.writeFile(src.workspaceRoot, body.path, body.content ?? '');
    audit.log('nanobot_workspace_file_update', {
      userId: req.user?.id,
      target: body.path,
      ip: req.ip,
      details: { source: src.key },
    });
    res.json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/file', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const relPath = req.query.path || '';
    if (!relPath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }
    const result = store.deleteFile(src.workspaceRoot, relPath);
    audit.log('nanobot_workspace_file_delete', {
      userId: req.user?.id,
      target: relPath,
      ip: req.ip,
      details: { source: src.key },
    });
    res.json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/dir', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const relPath = req.query.path || '';
    if (!relPath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }
    const result = store.deleteDirectory(src.workspaceRoot, relPath);
    audit.log('nanobot_workspace_dir_delete', {
      userId: req.user?.id,
      target: relPath,
      ip: req.ip,
      details: { source: src.key },
    });
    res.json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/mkdir', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const body = req.body;
    if (!body || typeof body !== 'object' || !body.path) {
      return res.status(400).json({ error: 'JSON body with path required' });
    }
    const result = store.mkdir(src.workspaceRoot, body.path);
    audit.log('nanobot_workspace_mkdir', {
      userId: req.user?.id,
      target: body.path,
      ip: req.ip,
      details: { source: src.key },
    });
    res.status(201).json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/rename', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    const body = req.body;
    if (!body || typeof body !== 'object' || !body.oldPath || !body.newPath) {
      return res.status(400).json({ error: 'JSON body with oldPath and newPath required' });
    }
    const result = store.rename(src.workspaceRoot, body.oldPath, body.newPath);
    audit.log('nanobot_workspace_rename', {
      userId: req.user?.id,
      target: body.oldPath,
      ip: req.ip,
      details: { source: src.key, newPath: body.newPath },
    });
    res.json({ ok: true, source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/git/status', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    // gitRoot query param overrides the source's git root (if set) or falls back to workspace root
    const gitRoot = req.query.gitRoot || src.gitRoot || src.workspaceRoot;
    const result = gitStore.getStatus(gitRoot);
    res.json({ source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/git/diff', (req, res, next) => {
  try {
    const src = sourceForReq(req);
    // gitRoot query param overrides the source's git root (if set) or falls back to workspace root
    const gitRoot = req.query.gitRoot || src.gitRoot || src.workspaceRoot;
    const filePath = req.query.path || '';
    const staged = req.query.staged === '1';
    const isUntracked = req.query.untracked === '1';

    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }

    const result = isUntracked
      ? gitStore.getNewFileDiff(gitRoot, filePath)
      : gitStore.getDiff(gitRoot, filePath, staged);

    res.json({ source: src.key, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
