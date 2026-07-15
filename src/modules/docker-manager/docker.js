'use strict';

const http = require('http');
const readline = require('readline');
const config = require('../../../config/default');

const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const IMAGE_REF_RE = /^[a-zA-Z0-9._:/@-]{1,256}$/;
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const NETWORK_ID_RE = /^[a-f0-9]{12,64}$/;
const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const SIGNAL_RE = /^[A-Z0-9]+$/;

function validateContainerId(id) {
  if (!id || typeof id !== 'string') throw new Error('Container ID required');
  if (!CONTAINER_ID_RE.test(id) && !CONTAINER_NAME_RE.test(id)) {
    throw new Error('Invalid container ID or name');
  }
}

function validateImageRef(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('Image reference required');
  if (!IMAGE_REF_RE.test(ref)) throw new Error('Invalid image reference');
}

function validateVolumeName(name) {
  if (!name || typeof name !== 'string' || !VOLUME_NAME_RE.test(name)) {
    throw new Error('Invalid volume name');
  }
}

function validateNetworkId(id) {
  if (!id || typeof id !== 'string') throw new Error('Network ID required');
  if (!NETWORK_ID_RE.test(id) && !NETWORK_NAME_RE.test(id)) {
    throw new Error('Invalid network ID or name');
  }
}

function validateSignal(signal) {
  if (!SIGNAL_RE.test(String(signal || ''))) throw new Error('Invalid signal');
}

function dockerRequest(method, path, { body = null, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: config.docker.socketPath,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout,
    };

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          let msg = `Docker API ${res.statusCode}`;
          try { msg = JSON.parse(raw).message || msg; } catch {}
          return reject(new Error(msg));
        }
        if (!raw) return resolve(null);
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Docker request timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Stream a chunked Docker Engine response line-by-line. Each newline-delimited
 * JSON object is parsed and passed to onLine(obj, raw). Used for image pulls.
 */
function dockerStream(method, path, { body = null, timeout = 0, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: config.docker.socketPath,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout,
    };

    const req = http.request(opts, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let msg = `Docker API ${res.statusCode}`;
          try { msg = JSON.parse(raw).message || msg; } catch {}
          reject(new Error(msg));
        });
        return;
      }

      const rl = readline.createInterface({ input: res });
      rl.on('line', (line) => {
        if (!line || !onLine) return;
        let obj = null;
        try { obj = JSON.parse(line); } catch { /* non-JSON line, ignore */ }
        try { onLine(obj, line); } catch { /* handler error, keep streaming */ }
      });
      res.on('error', reject);
      res.on('end', () => resolve());
    });

    req.on('error', reject);
    if (timeout) req.on('timeout', () => { req.destroy(); reject(new Error('Docker stream timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Containers ───

/**
 * Build the path+query for a Docker Engine prune endpoint. `filters` is an
 * object whose values are arrays of strings (per the Docker Engine API
 * convention); empty filters return the path unchanged.
 */
function prunePath(path, filters) {
  if (!filters || !Object.keys(filters).length) return path;
  const qs = new URLSearchParams();
  qs.set('filters', JSON.stringify(filters));
  return `${path}?${qs.toString()}`;
}

async function listContainers(all = false) {
  return dockerRequest('GET', `/containers/json?all=${all}`);
}

async function inspectContainer(id) {
  validateContainerId(id);
  return dockerRequest('GET', `/containers/${id}/json`);
}

async function startContainer(id) {
  validateContainerId(id);
  return dockerRequest('POST', `/containers/${id}/start`);
}

async function stopContainer(id) {
  validateContainerId(id);
  return dockerRequest('POST', `/containers/${id}/stop?t=10`);
}

async function restartContainer(id) {
  validateContainerId(id);
  return dockerRequest('POST', `/containers/${id}/restart?t=10`);
}

async function pauseContainer(id) {
  validateContainerId(id);
  return dockerRequest('POST', `/containers/${id}/pause`);
}

async function unpauseContainer(id) {
  validateContainerId(id);
  return dockerRequest('POST', `/containers/${id}/unpause`);
}

async function killContainer(id, signal = 'SIGKILL') {
  validateContainerId(id);
  validateSignal(signal);
  return dockerRequest('POST', `/containers/${id}/kill?signal=${signal}`);
}

async function renameContainer(id, name) {
  validateContainerId(id);
  if (!name || !CONTAINER_NAME_RE.test(name)) throw new Error('Invalid container name');
  return dockerRequest('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`);
}

async function removeContainer(id, force = false) {
  validateContainerId(id);
  return dockerRequest('DELETE', `/containers/${id}?force=${force}`);
}

async function pruneContainers(filters = {}) {
  return dockerRequest('POST', prunePath('/containers/prune', filters));
}

async function containerLogs(id, tail = 100) {
  validateContainerId(id);
  const n = Math.max(1, Math.min(parseInt(tail, 10) || 100, 1000));
  const raw = await dockerRequest('GET', `/containers/${id}/logs?stdout=true&stderr=true&tail=${n}`);
  if (typeof raw === 'string') {
    return raw.replace(/[\x00-\x08]/g, '');
  }
  return String(raw);
}

async function containerStats(id) {
  validateContainerId(id);
  return dockerRequest('GET', `/containers/${id}/stats?stream=false`, { timeout: 15000 });
}

async function containerTop(id) {
  validateContainerId(id);
  return dockerRequest('GET', `/containers/${id}/top`);
}

// ─── Images ───

async function listImages() {
  return dockerRequest('GET', '/images/json');
}

async function inspectImage(ref) {
  validateImageRef(ref);
  return dockerRequest('GET', `/images/${encodeURIComponent(ref)}/json`);
}

async function removeImage(ref, { force = false, noprune = false } = {}) {
  validateImageRef(ref);
  return dockerRequest('DELETE', `/images/${encodeURIComponent(ref)}?force=${force}&noprune=${noprune}`);
}

async function pruneImages(filters = {}) {
  return dockerRequest('POST', prunePath('/images/prune', filters));
}

/**
 * Pull an image, streaming progress. onLine(obj, raw) is called for each
 * newline-delimited status object Docker emits (status / progressDetail / error).
 * Resolves when the pull completes; rejects on error.
 */
function pullImage(name, tag, onLine) {
  if (!name || typeof name !== 'string') throw new Error('Image name required');
  const q = new URLSearchParams({ fromImage: name });
  if (tag) q.set('tag', tag);
  return dockerStream('POST', `/images/create?${q.toString()}`, {
    timeout: config.docker.pull?.timeoutMs || 600000,
    onLine,
  });
}

// ─── Volumes ───

async function listVolumes() {
  return dockerRequest('GET', '/volumes');
}

async function inspectVolume(name) {
  validateVolumeName(name);
  return dockerRequest('GET', `/volumes/${encodeURIComponent(name)}`);
}

async function removeVolume(name, force = false) {
  validateVolumeName(name);
  return dockerRequest('DELETE', `/volumes/${encodeURIComponent(name)}?force=${force}`);
}

async function pruneVolumes(filters = {}) {
  return dockerRequest('POST', prunePath('/volumes/prune', filters));
}

// ─── Networks ───

async function listNetworks() {
  return dockerRequest('GET', '/networks');
}

async function inspectNetwork(id) {
  validateNetworkId(id);
  return dockerRequest('GET', `/networks/${encodeURIComponent(id)}`);
}

async function removeNetwork(id) {
  validateNetworkId(id);
  return dockerRequest('DELETE', `/networks/${encodeURIComponent(id)}`);
}

async function pruneNetworks(filters = {}) {
  return dockerRequest('POST', prunePath('/networks/prune', filters));
}

// ─── System ───

async function getSystemInfo() {
  return dockerRequest('GET', '/info');
}

async function systemDf() {
  return dockerRequest('GET', '/system/df');
}

// ─── Stats helpers ───

/**
 * Derive a compact, UI-friendly stats summary from a /containers/{id}/stats blob.
 * Returns null when the daemon hasn't accumulated enough samples to compute CPU.
 */
function compactStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const cpu = stats.cpu_stats || {};
  const precpu = stats.precpu_stats || {};
  const mem = stats.memory_stats || {};

  let cpuPct = null;
  const cpuDelta = (cpu.cpu_usage?.total_usage || 0) - (precpu.cpu_usage?.total_usage || 0);
  const sysDelta = (cpu.system_cpu_usage || 0) - (precpu.system_cpu_usage || 0);
  const onlineCpus = cpu.online_cpus || (cpu.cpu_usage?.percpu_usage?.length) || 1;
  if (sysDelta > 0 && cpuDelta >= 0) {
    cpuPct = ((cpuDelta / sysDelta) * onlineCpus) * 100;
  }

  const memUsed = mem.usage ? mem.usage - (mem.stats?.cache || (mem.stats && mem.stats['total-cache']) || 0) : 0;
  const memLimit = mem.limit || 0;

  let netRx = 0, netTx = 0;
  const nets = stats.networks || {};
  for (const k of Object.keys(nets)) {
    netRx += nets[k].rx_bytes || 0;
    netTx += nets[k].tx_bytes || 0;
  }

  let blkRead = 0, blkWrite = 0;
  const blkio = stats.blkio_stats;
  if (blkio && Array.isArray(blkio.io_service_bytes_recursive)) {
    for (const e of blkio.io_service_bytes_recursive) {
      if (e.op === 'read') blkRead += e.value || 0;
      else if (e.op === 'write') blkWrite += e.value || 0;
    }
  }

  return {
    cpuPct: cpuPct == null ? null : Math.round(cpuPct * 10) / 10,
    memUsed,
    memLimit,
    memPct: memLimit > 0 ? Math.round((memUsed / memLimit) * 1000) / 10 : null,
    netRx, netTx, blkRead, blkWrite,
    read: stats.read || null,
  };
}

module.exports = {
  // request helpers (re-used by exec-bridge)
  dockerRequest, dockerStream, validateContainerId,
  // containers
  listContainers, inspectContainer, startContainer, stopContainer, restartContainer,
  pauseContainer, unpauseContainer, killContainer, renameContainer, removeContainer,
  pruneContainers, containerLogs, containerStats, containerTop,
  // images
  listImages, inspectImage, removeImage, pruneImages, pullImage,
  // volumes
  listVolumes, inspectVolume, removeVolume, pruneVolumes,
  // networks
  listNetworks, inspectNetwork, removeNetwork, pruneNetworks,
  // system
  getSystemInfo, systemDf,
  // stats
  compactStats,
};
