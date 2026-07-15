'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const manager = require('./download-manager');
const audit = require('../../../core/audit-log');

const MIME_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  opus: 'audio/opus',
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

let broadcast = () => {};

// GET /search?query=<terms>
router.get('/search', async (req, res, next) => {
  try {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const result = await manager.runCommand(['search', query], 30000);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /download
router.post('/download', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });

    const user = req.user?.username || req.user?.id || 'anonymous';
    console.log(`[music-download] request: query="${query}" user=${user} ip=${req.ip}`);
    audit.log('music_download_request', { userId: req.user?.id || null, target: query, ip: req.ip });

    // Check active downloads limit
    const active = manager.getActiveDownloads().filter(d =>
      d.status !== 'completed' && d.status !== 'failed' && d.status !== 'cancelled'
    );
    const maxConcurrent = 1;
    if (active.length >= maxConcurrent) {
      console.log(`[music-download] rejected (another download in progress): query="${query}"`);
      return res.status(429).json({ error: 'A download is already in progress. Wait for it to finish.' });
    }

    const downloadId = manager.startDownload(query, (progress) => {
      broadcast('music-download:progress', progress);

      // Lifecycle logging on the alapaap server
      if (progress.status === 'completed') {
        const filePath = progress.data?.filePath || '';
        const title = progress.data?.title || progress.title || '';
        if (filePath) {
          console.log(`[music-download] completed id=${progress.downloadId} title="${title}" file=${filePath}`);
        } else {
          // Phase B: the Python CLI should now raise instead of returning
          // success-with-no-file, so this branch should be unreachable. Log
          // defensively in case a future regression sneaks back in.
          console.warn(`[music-download] completed with empty filePath id=${progress.downloadId} title="${title}" — upstream returned success but no file`);
        }
        audit.log('music_download_complete', {
          userId: req.user?.id || null, target: query, ip: req.ip,
          details: { title, filePath, saved: Boolean(filePath) },
        });
      } else if (progress.status === 'failed') {
        console.log(`[music-download] failed id=${progress.downloadId} error="${progress.error || ''}"`);
        audit.log('music_download_failed', {
          userId: req.user?.id || null, target: query, ip: req.ip,
          details: { error: progress.error || null },
        });
      }
    });

    console.log(`[music-download] started id=${downloadId} query="${query}"`);
    res.json({ downloadId, status: 'started' });
  } catch (err) { next(err); }
});

// GET /library
router.get('/library', async (req, res, next) => {
  try {
    const result = await manager.runCommand(['library'], 15000);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /delete
router.post('/delete', async (req, res, next) => {
  try {
    const { filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    const result = await manager.runCommand(['delete', filePath], 10000);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /status/:id
router.get('/status/:id', async (req, res, next) => {
  try {
    const status = manager.getDownloadStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Download not found' });
    res.json(status);
  } catch (err) { next(err); }
});

// GET /active
router.get('/active', async (req, res) => {
  res.json(manager.getActiveDownloads());
});

// GET /stream?path=<relative path>
router.get('/stream', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const downloadPath = manager.getDownloadPath();
    const filePath = path.resolve(downloadPath, req.query.path);

    // Security: ensure path is within download directory
    const resolvedBase = path.resolve(downloadPath);
    if (!filePath.startsWith(resolvedBase + path.sep) && filePath !== resolvedBase) {
      return res.status(403).json({ error: 'Path outside download directory' });
    }

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

function setBroadcast(fn) {
  broadcast = fn;
}

module.exports = router;
module.exports.setBroadcast = setBroadcast;
