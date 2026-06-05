'use strict';

const http = require('http');
const config = require('../../../config/default');

const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

function validateContainerId(id) {
  if (!id || typeof id !== 'string') throw new Error('Container ID required');
  if (!CONTAINER_ID_RE.test(id) && !CONTAINER_NAME_RE.test(id)) {
    throw new Error('Invalid container ID or name');
  }
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

async function removeContainer(id, force = false) {
  validateContainerId(id);
  return dockerRequest('DELETE', `/containers/${id}?force=${force}`);
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

async function listImages() {
  return dockerRequest('GET', '/images/json');
}

async function getSystemInfo() {
  return dockerRequest('GET', '/info');
}

module.exports = {
  listContainers, inspectContainer, startContainer, stopContainer,
  restartContainer, removeContainer, containerLogs, listImages, getSystemInfo,
};
