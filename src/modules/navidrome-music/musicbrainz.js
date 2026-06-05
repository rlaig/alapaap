'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const MB_API = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'alapaap/1.0 (navidrome-music-manager)';
const COVERART_API = 'https://coverartarchive.org';

let toneBin = '/usr/local/bin/tone';

let lastRequestTime = 0;

function configure(cfg) {
  if (cfg.toneBin) toneBin = cfg.toneBin;
}

function httpGet(url, { followRedirects = 5, timeout = 15000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': MB_USER_AGENT }, timeout }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && followRedirects > 0) {
        return resolve(httpGet(res.headers.location, { followRedirects: followRedirects - 1, timeout, binary }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(binary ? buf : buf.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function mbRequest(url) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();

  try {
    const body = await httpGet(url);
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function cleanTitle(title, aggressive = false) {
  let t = title
    .replace(/\s*[(\[][^)\]]*(?:official|video|audio|lyric|visualizer|remaster|hd|hq|explicit|clean|mv|m\/v|4k|1080p)[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|\s*official\b.*/gi, '')
    .replace(/\s*-\s*official\b.*/gi, '')
    .trim();
  if (aggressive) {
    t = t.replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim();
  }
  return t;
}

function cleanArtist(artist) {
  return artist
    .replace(/\s*(official\s*channel|vevo|topic|-\s*topic)$/i, '')
    .trim();
}

function pickBestRelease(recordings) {
  let best = null;
  let bestScore = -1;
  let bestDate = '9999';

  for (const rec of recordings) {
    for (const rel of (rec.releases || [])) {
      const rg = rel['release-group'] || {};
      const primary = rg['primary-type'] || '';
      const secondary = rg['secondary-types'] || [];

      let score = 0;
      if (primary === 'Album' && secondary.length === 0) score = 3;
      else if (primary === 'Album') score = 1;

      const relDate = rel.date || rec['first-release-date'] || '9999';
      const better = score > bestScore || (score === bestScore && relDate < bestDate);

      if (better) {
        bestScore = score;
        bestDate = relDate;
        let trackNumber = null;
        let discNumber = null;
        for (const medium of (rel.media || [])) {
          for (const t of (medium.track || [])) {
            const n = parseInt(t.number, 10);
            if (!Number.isNaN(n)) trackNumber = n;
            discNumber = medium.position || null;
            break;
          }
          if (trackNumber != null) break;
        }
        best = { recording: rec, release: rel, trackNumber, discNumber };
      }
    }
  }
  return best;
}

function buildSearchPairs(title, artist) {
  const ca = cleanArtist(artist || '');
  const pairs = [];

  const ct = cleanTitle(title || '');
  const ctAgg = cleanTitle(title || '', true);

  function addPair(t, a) {
    const key = `${t.toLowerCase()}||${a.toLowerCase()}`;
    if (t && !pairs.some((p) => `${p.title.toLowerCase()}||${p.artist.toLowerCase()}` === key)) {
      pairs.push({ title: t, artist: a });
    }
  }

  for (const cleaned of [ct, ctAgg]) {
    if (cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ', 2);
      addPair(parts[1].trim(), parts[0].trim());
    }
    addPair(cleaned, ca);
  }

  return pairs;
}

async function queryMb(searchTitle, searchArtist, minScore = 80) {
  const parts = [];
  if (searchArtist) parts.push(`artist:"${searchArtist}"`);
  parts.push(`recording:"${searchTitle}"`);
  const query = parts.join(' AND ');
  const qs = new URLSearchParams({ query, fmt: 'json', limit: '5' });
  const url = `${MB_API}/recording/?${qs}`;

  const data = await mbRequest(url);
  if (!data?.recordings?.length) return null;

  const topRecordings = data.recordings.filter((r) => (r.score || 0) >= minScore);
  if (topRecordings.length === 0) return null;

  const pick = pickBestRelease(topRecordings);
  if (!pick) return null;

  const rec = pick.recording;
  const rel = pick.release;

  const allTags = {};
  for (const r of topRecordings) {
    for (const t of (r.tags || [])) {
      if (t.name && t.count > 0) allTags[t.name] = Math.max(allTags[t.name] || 0, t.count);
    }
    for (const g of (r.genres || [])) {
      if (g.name) allTags[g.name] = Math.max(allTags[g.name] || 0, 1);
    }
  }
  const genres = Object.keys(allTags).sort((a, b) => allTags[b] - allTags[a]);

  const artistNames = (rec['artist-credit'] || []).map((ac) => ac.name).filter(Boolean);
  const mbArtist = artistNames.length ? artistNames.join(', ') : (searchArtist || '');

  let releaseDate = rel.date || '';
  if (!releaseDate) releaseDate = rec['first-release-date'] || '';

  return {
    title: rec.title || searchTitle,
    artist: mbArtist,
    album: rel.title || '',
    albumArtist: mbArtist,
    genre: genres[0] || '',
    recordingDate: releaseDate,
    trackNumber: pick.trackNumber,
    discNumber: pick.discNumber,
    releaseId: rel.id || '',
  };
}

async function searchMetadata(title, artist) {
  const pairs = buildSearchPairs(title, artist);

  for (const pair of pairs) {
    const result = await queryMb(pair.title, pair.artist, 80);
    if (result) return result;
  }

  for (const pair of pairs) {
    const result = await queryMb(pair.title, '', 80);
    if (result) return result;
  }

  return null;
}

async function fetchCoverArt(releaseId) {
  if (!releaseId) return null;

  const url = `${COVERART_API}/release/${releaseId}/front`;
  const dest = path.join('/tmp', `cover_${randomUUID().replace(/-/g, '')}.jpg`);

  try {
    const data = await httpGet(url, { binary: true, timeout: 15000 });
    if (data.length > 0) {
      await fs.promises.writeFile(dest, data);
      return dest;
    }
  } catch { /* ignore */ }

  try { await fs.promises.unlink(dest); } catch { /* ignore */ }
  return null;
}

async function applySyncTags(musicFile, metadata, coverPath) {
  const toneMeta = {};
  if (metadata.title) toneMeta.title = metadata.title;
  if (metadata.artist) toneMeta.artist = metadata.artist;
  if (metadata.album) toneMeta.album = metadata.album;
  if (metadata.albumArtist) toneMeta.albumArtist = metadata.albumArtist;
  if (metadata.genre) toneMeta.genre = metadata.genre;
  if (metadata.trackNumber) toneMeta.trackNumber = metadata.trackNumber;
  if (metadata.discNumber) toneMeta.discNumber = metadata.discNumber;

  let dateStr = metadata.recordingDate || '';
  if (dateStr) {
    if (dateStr.length === 4) dateStr = `${dateStr}-01-01`;
    else if (dateStr.length === 7) dateStr = `${dateStr}-01`;
    toneMeta.recordingDate = `${dateStr}T00:00:00`;
  }

  const jsonPath = path.join('/tmp', `tone_meta_${randomUUID().replace(/-/g, '')}.json`);

  try {
    await fs.promises.writeFile(jsonPath, JSON.stringify({ meta: toneMeta }));

    const args = ['tag', musicFile, '--meta-tone-json-file', jsonPath, '-y'];
    if (coverPath && fs.existsSync(coverPath)) {
      args.push('--meta-cover-file', coverPath);
    }

    await new Promise((resolve, reject) => {
      execFile(toneBin, args, { timeout: 30000 }, (err) => {
        if (err) return reject(new Error(`tone tag failed: ${err.message}`));
        resolve();
      });
    });

    return { ok: true, hasCover: !!(coverPath && fs.existsSync(coverPath)) };
  } finally {
    try { await fs.promises.unlink(jsonPath); } catch { /* ignore */ }
    if (coverPath) {
      try { await fs.promises.unlink(coverPath); } catch { /* ignore */ }
    }
  }
}

module.exports = { configure, searchMetadata, fetchCoverArt, applySyncTags };
