'use strict';

/**
 * Interactive `docker exec` terminal bridge.
 *
 * Pairs a single authenticated WebSocket (see core/websocket.js
 * registerMessageHandler) with a Docker exec TTY session using the Engine API
 * hijack flow:
 *
 *   1. POST /containers/{id}/exec  -> { Id }            (Tty:true)
 *   2. raw socket: POST /exec/{Id}/start with Connection: Upgrade, Upgrade: tcp
 *      After the daemon's HTTP/1.1 101 response the unix socket becomes a raw
 *      bidirectional TTY byte stream (Tty:true => no 8-byte stream framing).
 *
 * Pty bytes are carried inside the shared JSON WebSocket as base64:
 *   client -> server: { type:'exec:input',  execId, data }   (data = base64)
 *   server -> client: { type:'exec:output', execId, data }
 *                   { type:'exec:ready',  execId }
 *                   { type:'exec:exit',   execId, code }
 *                   { type:'exec:error',  execId, message }
 *
 * Resize is a normal (non-hijacked) POST /exec/{Id}/resize?h=&w=.
 */

const net = require('net');
const config = require('../../../config/default');
const { dockerRequest, validateContainerId, inspectContainer } = require('./docker');
const audit = require('../../core/audit-log');

const sessions = new Map(); // execId -> { ws, sock, dockerExecId, containerId, user, cmd }

function cfg() {
  return Object.assign({ enabled: true, maxSessions: 5 }, config.docker?.exec);
}

function wsIp(ws) {
  try { return ws?._socket?.remoteAddress || null; } catch { return null; }
}

function wsSend(ws, obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* client gone */ }
}

function sessionsForWs(ws) {
  const out = [];
  for (const [, s] of sessions) if (s.ws === ws) out.push(s);
  return out;
}

function ensureWsCleanup(ws) {
  if (ws._dkExecCloseRegistered) return;
  ws._dkExecCloseRegistered = true;
  ws.once('close', () => detachAllForWs(ws));
}

function validDims(n) {
  const v = parseInt(n, 10);
  return Number.isInteger(v) && v >= 1 && v <= 500 ? v : null;
}

/**
 * Attach a new exec session. Message shape:
 * { type:'exec:attach', execId, containerId, cmd:[shell], user, cols, rows }
 */
async function attach(ws, msg) {
  const c = cfg();
  if (!c.enabled) {
    return wsSend(ws, { type: 'exec:error', execId: msg?.execId, message: 'Exec is disabled' });
  }
  const execId = msg?.execId;
  const containerId = msg?.containerId;
  if (!execId || typeof execId !== 'string') {
    return wsSend(ws, { type: 'exec:error', execId, message: 'Missing execId' });
  }
  if (sessions.has(execId)) {
    return wsSend(ws, { type: 'exec:error', execId, message: 'Session already exists' });
  }
  if (sessionsForWs(ws).length >= c.maxSessions) {
    return wsSend(ws, { type: 'exec:error', execId, message: `Session limit (${c.maxSessions}) reached` });
  }

  let cmd = msg.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0) cmd = [c.defaultShell || '/bin/sh'];
  const shell = String(cmd[0]);
  const allowed = c.allowedShells || ['/bin/sh', '/bin/bash', '/bin/ash', 'sh', 'bash'];
  if (!allowed.includes(shell)) {
    return wsSend(ws, { type: 'exec:error', execId, message: `Shell not allowed: ${shell}` });
  }
  const user = msg.user || c.defaultUser || 'root';
  if (!c.userPattern?.test(user)) {
    return wsSend(ws, { type: 'exec:error', execId, message: 'Invalid user' });
  }

  try {
    validateContainerId(containerId);
  } catch (err) {
    return wsSend(ws, { type: 'exec:error', execId, message: err.message });
  }

  // Exec requires a running container.
  try {
    const info = await inspectContainer(containerId);
    if (!info?.State?.Running) {
      return wsSend(ws, { type: 'exec:error', execId, message: 'Container is not running' });
    }
    if (info.State.Paused) {
      return wsSend(ws, { type: 'exec:error', execId, message: 'Container is paused' });
    }
  } catch (err) {
    return wsSend(ws, { type: 'exec:error', execId, message: err.message });
  }

  // Create the exec instance.
  let dockerExecId;
  try {
    const created = await dockerRequest('POST', `/containers/${containerId}/exec`, {
      body: {
        AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Tty: true, Cmd: cmd, User: user,
      },
    });
    dockerExecId = created?.Id;
    if (!dockerExecId) throw new Error('Docker did not return an exec Id');
  } catch (err) {
    return wsSend(ws, { type: 'exec:error', execId, message: err.message });
  }

  const cols = validDims(msg.cols) || 80;
  const rows = validDims(msg.rows) || 24;
  const socketPath = config.docker?.socketPath || '/var/run/docker.sock';

  const session = { ws, sock: null, dockerExecId, containerId, user, cmd };
  sessions.set(execId, session);
  ensureWsCleanup(ws);

  const startBody = JSON.stringify({ Detach: false, Tty: true });
  const startReq =
    `POST /exec/${dockerExecId}/start HTTP/1.1\r\n` +
    `Host: docker\r\n` +
    `Connection: Upgrade\r\n` +
    `Upgrade: tcp\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(startBody)}\r\n\r\n` +
    startBody;

  let headerBuf = Buffer.alloc(0);
  let headerDone = false;
  let readySent = false;

  const sock = net.connect(socketPath);
  session.sock = sock;

  sock.on('connect', () => {
    try { sock.write(startReq); } catch (err) {
      wsSend(ws, { type: 'exec:error', execId, message: err.message });
      teardown(execId);
    }
  });

  sock.on('data', (chunk) => {
    if (!headerDone) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (headerBuf.length > 65536) {
          wsSend(ws, { type: 'exec:error', execId, message: 'No HTTP response from Docker' });
          teardown(execId);
        }
        return;
      }
      headerDone = true;
      const header = headerBuf.slice(0, idx).toString();
      const tail = headerBuf.slice(idx + 4);
      headerBuf = null;

      const statusLine = header.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
      const code = m ? parseInt(m[1], 10) : 0;
      if (code !== 101) {
        wsSend(ws, { type: 'exec:error', execId, message: `Docker did not upgrade: ${statusLine}` });
        teardown(execId);
        return;
      }

      readySent = true;
      wsSend(ws, { type: 'exec:ready', execId });
      // Apply the terminal size now that the exec is live.
      resize(execId, cols, rows).catch(() => {});
      if (tail.length) wsSend(ws, { type: 'exec:output', execId, data: tail.toString('base64') });
      return;
    }
    wsSend(ws, { type: 'exec:output', execId, data: chunk.toString('base64') });
  });

  sock.on('error', (err) => {
    if (readySent) {
      wsSend(ws, { type: 'exec:exit', execId, code: -1 });
    } else {
      wsSend(ws, { type: 'exec:error', execId, message: err.message });
    }
    teardown(execId);
  });

  sock.on('close', () => {
    if (sessions.has(execId)) {
      if (readySent) wsSend(ws, { type: 'exec:exit', execId });
      teardown(execId);
    }
  });

  audit.log('container_exec_attach', {
    userId: ws.user?.id,
    target: containerId,
    ip: wsIp(ws),
    details: { execId, dockerExecId, user, cmd },
  });
}

/** Write client keystrokes to the pty. data is base64. */
function input(execId, data) {
  const s = sessions.get(execId);
  if (!s?.sock) return;
  try { s.sock.write(Buffer.from(data || '', 'base64')); } catch { /* gone */ }
}

/** Resize the live pty. */
async function resize(execId, cols, rows) {
  const s = sessions.get(execId);
  if (!s?.dockerExecId) return;
  const h = validDims(rows);
  const w = validDims(cols);
  if (!h || !w) return;
  try {
    await dockerRequest('POST', `/exec/${s.dockerExecId}/resize?h=${h}&w=${w}`, { timeout: 5000 });
  } catch { /* non-fatal */ }
}

/** Client-initiated detach. */
function detach(execId) {
  teardown(execId, true);
}

function detachAllForWs(ws) {
  for (const s of sessionsForWs(ws)) teardown(getExecIdForSession(s), false);
}

function getExecIdForSession(session) {
  for (const [id, s] of sessions) if (s === session) return id;
  return null;
}

function teardown(execId, clientInitiated = false) {
  const s = sessions.get(execId);
  if (!s) return;
  sessions.delete(execId);
  try { s.sock?.destroy(); } catch { /* ignore */ }
  if (clientInitiated) {
    audit.log('container_exec_detach', {
      userId: s.ws?.user?.id,
      target: s.containerId,
      ip: wsIp(s.ws),
      details: { execId, dockerExecId: s.dockerExecId, user: s.user },
    });
  }
}

function activeCount() {
  return sessions.size;
}

function destroyAll() {
  for (const id of Array.from(sessions.keys())) teardown(id, false);
}

module.exports = { attach, input, resize, detach, activeCount, destroyAll };
