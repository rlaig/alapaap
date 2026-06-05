'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

let musicPath = '/path/navidrome/music';
let toneBin = '/usr/local/bin/tone';
let supportedExtensions = ['mp3', 'm4a', 'flac', 'ogg', 'wav', 'opus', 'wma', 'aac'];

function configure(cfg) {
  musicPath = cfg.musicPath;
  toneBin = cfg.toneBin;
  if (cfg.supportedExtensions) supportedExtensions = cfg.supportedExtensions;
}

function resolveSafe(relative) {
  const resolved = path.resolve(musicPath, relative || '');
  if (!resolved.startsWith(path.resolve(musicPath))) {
    throw Object.assign(new Error('Path outside music directory'), { status: 403 });
  }
  return resolved;
}

function isAudioFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return supportedExtensions.includes(ext);
}

async function scanDirectory(relative) {
  const dir = resolveSafe(relative || '');
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  const folders = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      folders.push({ name: entry.name, type: 'directory' });
    } else if (isAudioFile(entry.name)) {
      try {
        const stat = await fs.promises.stat(path.join(dir, entry.name));
        files.push({
          name: entry.name,
          type: 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
          extension: path.extname(entry.name).slice(1).toLowerCase(),
        });
      } catch {
        files.push({
          name: entry.name,
          type: 'file',
          size: 0,
          modified: null,
          extension: path.extname(entry.name).slice(1).toLowerCase(),
        });
      }
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return { path: relative || '', folders, files, total: files.length };
}

function runTone(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(toneBin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        return reject(new Error(`tone error: ${msg}`));
      }
      resolve(stdout);
    });
  });
}

function spawnTone(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(toneBin, args, { timeout: timeoutMs });
    const chunks = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => reject(new Error(`tone error: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tone error (exit ${code}): ${stderr.trim()}`));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function stripPictureData(data) {
  if (data?.meta?.embeddedPictures) {
    data.meta.embeddedPictures = data.meta.embeddedPictures.map((p) => ({
      code: p.code,
      mimetype: p.mimetype,
      hasData: !!(p.data && p.data.length > 0),
    }));
  }
  return data;
}

async function getFileMetadata(relative) {
  const filePath = resolveSafe(relative);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('File not found'), { status: 404 });
  }

  const raw = await spawnTone(['dump', filePath, '--format', 'json']);
  try {
    return stripPictureData(JSON.parse(raw));
  } catch {
    throw new Error('Failed to parse tone output');
  }
}

function parseMultiJson(raw) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { results.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  return results;
}

const BATCH_META_PROPERTIES = [
  'title', 'artist', 'album', 'albumArtist', 'genre',
  'trackNumber', 'discNumber', 'recordingDate',
];

async function getBatchMetadata(relative, limit = 200) {
  const dir = resolveSafe(relative || '');
  const args = ['dump', dir, '--format', 'json', '--limit', String(limit)];
  for (const prop of BATCH_META_PROPERTIES) {
    args.push('--include-property', prop);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(toneBin, args, { timeout: 60000 });
    const chunks = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => reject(new Error(`tone error: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`tone error (exit ${code}): ${stderr.trim()}`));
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(parseMultiJson(raw));
    });
  });
}

const TAG_FIELD_MAP = {
  title: '--meta-title',
  artist: '--meta-artist',
  album: '--meta-album',
  albumArtist: '--meta-album-artist',
  genre: '--meta-genre',
  composer: '--meta-composer',
  comment: '--meta-comment',
  trackNumber: '--meta-track-number',
  trackTotal: '--meta-track-total',
  discNumber: '--meta-disc-number',
  discTotal: '--meta-disc-total',
  recordingDate: '--meta-recording-date',
  publisher: '--meta-publisher',
  copyright: '--meta-copyright',
  description: '--meta-description',
  narrator: '--meta-narrator',
  encodedBy: '--meta-encoded-by',
};

async function updateTags(relative, tags, dryRun = false) {
  const filePath = resolveSafe(relative);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('File not found'), { status: 404 });
  }

  const args = ['tag', filePath];
  let hasFields = false;

  for (const [key, value] of Object.entries(tags)) {
    const flag = TAG_FIELD_MAP[key];
    if (!flag) continue;
    args.push(flag, String(value));
    hasFields = true;
  }

  if (!hasFields) {
    throw Object.assign(new Error('No valid tag fields provided'), { status: 400 });
  }

  if (dryRun) {
    args.push('--dry-run');
  } else {
    args.push('--assume-yes');
  }

  const output = await runTone(args);
  return { ok: true, dryRun, output: output.trim() };
}

async function batchUpdateTags(items, dryRun = false) {
  const results = [];
  for (const item of items) {
    try {
      const result = await updateTags(item.path, item.tags, dryRun);
      results.push({ path: item.path, ...result });
    } catch (err) {
      results.push({ path: item.path, ok: false, error: err.message });
    }
  }
  return results;
}

async function getStats() {
  const stats = { totalFiles: 0, totalSize: 0, byExtension: {}, byFolder: {} };

  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full, rel ? `${rel}/${entry.name}` : entry.name);
      } else if (isAudioFile(entry.name)) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        const folder = rel || '/';
        try {
          const stat = await fs.promises.stat(full);
          stats.totalFiles++;
          stats.totalSize += stat.size;
          stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
          stats.byFolder[folder] = (stats.byFolder[folder] || 0) + 1;
        } catch { /* skip */ }
      }
    }
  }

  await walk(musicPath, '');
  return stats;
}

async function getCoverArt(relative) {
  const filePath = resolveSafe(relative);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('File not found'), { status: 404 });
  }

  const raw = await spawnTone(['dump', filePath, '--format', 'json', '--include-property', 'embeddedPictures']);
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('Failed to parse tone output');
  }

  const pics = parsed?.meta?.embeddedPictures;
  if (!Array.isArray(pics) || pics.length === 0 || !pics[0].data) {
    return null;
  }

  return {
    mimetype: pics[0].mimetype || 'image/jpeg',
    buffer: Buffer.from(pics[0].data, 'base64'),
  };
}

async function deleteFile(relative) {
  const filePath = resolveSafe(relative);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('File not found'), { status: 404 });
  }
  const stat = await fs.promises.stat(filePath);
  if (stat.isDirectory()) {
    throw Object.assign(new Error('Cannot delete directories'), { status: 400 });
  }
  await fs.promises.unlink(filePath);
  return { ok: true, deleted: relative };
}

module.exports = {
  configure,
  resolveSafe,
  scanDirectory,
  getFileMetadata,
  getBatchMetadata,
  updateTags,
  batchUpdateTags,
  getStats,
  getCoverArt,
  deleteFile,
};
