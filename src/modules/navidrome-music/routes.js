'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const music = require('./music');
const musicbrainz = require('./musicbrainz');
const audit = require('../../core/audit-log');

const MIME_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  wma: 'audio/x-ms-wma',
  aac: 'audio/aac',
};

function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const parts = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!parts) return null;
  const start = parseInt(parts[1], 10);
  const end = parts[2] ? parseInt(parts[2], 10) : fileSize - 1;
  if (start >= fileSize || end >= fileSize || start > end) return null;
  return { start, end };
}

router.get('/stream', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const filePath = music.resolveSafe(req.query.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    res.set('Content-Type', mime);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=3600');

    const range = parseRange(req.headers.range, stat.size);
    if (range) {
      res.status(206);
      res.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.set('Content-Length', range.end - range.start + 1);
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    } else {
      res.set('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) { next(err); }
});

router.get('/download', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const filePath = music.resolveSafe(req.query.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const basename = path.basename(filePath);

    res.set('Content-Type', mime);
    res.set('Content-Length', stat.size);
    const safeName = basename.replace(/[^\x20-\x7E]/g, '_');
    res.set('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(basename)}`);
    res.set('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

router.get('/browse', async (req, res, next) => {
  try {
    const data = await music.scanDirectory(req.query.path || '');
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/metadata', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const data = await music.getFileMetadata(req.query.path);
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/batch-metadata', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const data = await music.getBatchMetadata(req.query.path || '', limit);
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/tag', async (req, res, next) => {
  try {
    const { path: filePath, tags, dryRun } = req.body || {};
    if (!filePath || !tags) {
      return res.status(400).json({ error: 'path and tags are required' });
    }
    const result = await music.updateTags(filePath, tags, !!dryRun);
    if (!dryRun) {
      audit.log('navidrome_tag', {
        userId: req.user?.id,
        target: filePath,
        ip: req.ip,
        details: { tags },
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/batch-tag', async (req, res, next) => {
  try {
    const { files, dryRun } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }
    if (files.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 files per batch' });
    }
    const results = await music.batchUpdateTags(files, !!dryRun);
    if (!dryRun) {
      audit.log('navidrome_batch_tag', {
        userId: req.user?.id,
        target: `${files.length} files`,
        ip: req.ip,
      });
    }
    res.json(results);
  } catch (err) { next(err); }
});

router.get('/cover-art', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const art = await music.getCoverArt(req.query.path);
    if (!art) {
      return res.status(404).json({ error: 'No cover art embedded' });
    }
    res.set('Content-Type', art.mimetype);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(art.buffer);
  } catch (err) { next(err); }
});

router.get('/search-metadata', async (req, res, next) => {
  try {
    const { title, artist } = req.query;
    if (!title && !artist) {
      return res.status(400).json({ error: 'title or artist is required' });
    }
    const result = await musicbrainz.searchMetadata(title || '', artist || '');
    if (!result) {
      return res.json({ found: false });
    }
    res.json({ found: true, metadata: result });
  } catch (err) { next(err); }
});

router.post('/apply-sync', async (req, res, next) => {
  try {
    const { path: filePath, metadata } = req.body || {};
    if (!filePath || !metadata) {
      return res.status(400).json({ error: 'path and metadata are required' });
    }
    const absPath = music.resolveSafe(filePath);

    let coverPath = null;
    if (metadata.releaseId) {
      coverPath = await musicbrainz.fetchCoverArt(metadata.releaseId);
    }

    const result = await musicbrainz.applySyncTags(absPath, metadata, coverPath);
    audit.log('navidrome_sync', {
      userId: req.user?.id,
      target: filePath,
      ip: req.ip,
      details: { metadata: { title: metadata.title, artist: metadata.artist, album: metadata.album } },
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const data = await music.getStats();
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/delete', async (req, res, next) => {
  try {
    const { path: filePath } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const result = await music.deleteFile(filePath);
    audit.log('navidrome_delete', {
      userId: req.user?.id,
      target: filePath,
      ip: req.ip,
    });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
