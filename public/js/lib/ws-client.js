'use strict';

const WsClient = (() => {
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_DELAY = 30000;
  const handlers = new Map();
  let pendingSubscriptions = new Set();
  const reconnectCallbacks = new Set();
  const typeHandlers = new Map(); // custom message types (e.g. docker exec)
  let authenticated = false;
  let wasConnected = false;

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      authenticated = false;
      updateStatus('auth');
      const token = Api.getToken();
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }));
      }
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === 'auth') {
        if (msg.status === 'ok') {
          authenticated = true;
          updateStatus('ok');
          for (const ch of pendingSubscriptions) {
            ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
          }
          // Notify reconnect listeners (skip first connection)
          if (wasConnected) {
            for (const cb of reconnectCallbacks) {
              try { cb(); } catch { /* ignore */ }
            }
          }
          wasConnected = true;
        } else {
          updateStatus('fail');
        }
        return;
      }

      if (msg.type === 'data' && msg.channel) {
        const cbs = handlers.get(msg.channel);
        if (cbs) {
          for (const cb of cbs) cb(msg.data, msg.ts);
        }
        return;
      }

      // Custom bidirectional message types (e.g. docker exec terminal).
      const tcs = typeHandlers.get(msg.type);
      if (tcs) {
        for (const cb of tcs) {
          try { cb(msg); } catch { /* ignore handler error */ }
        }
      }
    };

    ws.onclose = () => {
      authenticated = false;
      updateStatus('off');
      scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
  }

  function subscribe(channel, callback) {
    if (!handlers.has(channel)) handlers.set(channel, new Set());
    handlers.get(channel).add(callback);
    pendingSubscriptions.add(channel);

    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify({ type: 'subscribe', channel }));
    }
  }

  function unsubscribe(channel, callback) {
    const cbs = handlers.get(channel);
    if (cbs) {
      cbs.delete(callback);
      if (cbs.size === 0) {
        handlers.delete(channel);
        pendingSubscriptions.delete(channel);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
        }
      }
    }
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
    authenticated = false;
  }

  function updateStatus(state) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    const map = {
      ok: ['[WS:OK]', 'text-ok'],
      auth: ['[WS:..]', 'text-warn'],
      fail: ['[WS:NO]', 'text-err'],
      off: ['[WS:--]', 'text-dim'],
    };
    const [text, cls] = map[state] || map.off;
    el.textContent = text;
    el.className = 'status-badge ' + cls;
  }

  function onReconnect(callback) {
    reconnectCallbacks.add(callback);
  }

  function offReconnect(callback) {
    reconnectCallbacks.delete(callback);
  }

  /**
   * Send a custom JSON message on the authenticated socket.
   * Returns true if sent, false if the socket isn't open/authed yet.
   */
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    return false;
  }

  /** Register a handler for a custom inbound message type (e.g. 'exec:output'). */
  function onMessage(type, callback) {
    if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
    typeHandlers.get(type).add(callback);
  }

  function offMessage(type, callback) {
    const cbs = typeHandlers.get(type);
    if (cbs) {
      cbs.delete(callback);
      if (cbs.size === 0) typeHandlers.delete(type);
    }
  }

  function isAuthenticated() { return authenticated; }

  return { connect, disconnect, subscribe, unsubscribe, onReconnect, offReconnect,
    send, onMessage, offMessage, isAuthenticated };
})();
