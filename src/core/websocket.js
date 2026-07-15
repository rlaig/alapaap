'use strict';

const { WebSocketServer } = require('ws');
const { authenticateWs } = require('./auth');
const config = require('../../config/default');

let wss = null;
const channels = new Map();
const messageHandlers = new Map();

function init(server) {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.isAuthenticated = false;
    ws.user = null;
    ws.subscriptions = new Set();

    const authMs = config.ws?.authTimeoutMs ?? 30000;
    const authTimer = setTimeout(() => {
      if (!ws.isAuthenticated) {
        try {
          ws.close(4401, 'Authentication required');
        } catch { /* ignore */ }
      }
    }, authMs);
    if (typeof authTimer.unref === 'function') authTimer.unref();
    ws.once('close', () => clearTimeout(authTimer));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (msg.type === 'auth') {
        const user = authenticateWs(msg.token);
        if (user) {
          clearTimeout(authTimer);
          ws.isAuthenticated = true;
          ws.user = user;
          ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth', status: 'fail' }));
        }
        return;
      }

      if (!ws.isAuthenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // Custom bidirectional message types (e.g. docker exec terminal).
      if (messageHandlers.has(msg.type)) {
        try {
          messageHandlers.get(msg.type)(ws, msg);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        return;
      }

      if (msg.type === 'subscribe' && msg.channel) {
        if (channels.has(msg.channel)) {
          ws.subscriptions.add(msg.channel);
          ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: `Unknown channel: ${msg.channel}` }));
        }
        return;
      }

      if (msg.type === 'unsubscribe' && msg.channel) {
        ws.subscriptions.delete(msg.channel);
        ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
        return;
      }
    });

    ws.on('error', () => {});
  });

  return wss;
}

function registerChannel(name) {
  if (!channels.has(name)) {
    channels.set(name, true);
  }
}

/**
 * Register a handler for a custom bidirectional WS message type.
 * Handlers receive (ws, msg) and are only invoked for authenticated clients.
 * Used by modules that need request/response or streaming flows on the shared
 * socket (e.g. the docker exec terminal).
 */
function registerMessageHandler(type, fn) {
  if (typeof type === 'string' && typeof fn === 'function') {
    messageHandlers.set(type, fn);
  }
}

function broadcast(channel, data) {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'data', channel, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.isAuthenticated && client.subscriptions.has(channel)) {
      client.send(payload);
    }
  }
}

function getWss() {
  return wss;
}

function closeAll() {
  if (wss) {
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close();
  }
}

module.exports = { init, registerChannel, registerMessageHandler, broadcast, getWss, closeAll };
