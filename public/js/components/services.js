'use strict';

const ServicesComponent = (() => {
  let wsHandler = null;
  let confirmTarget = null;
  let logViewer = null;

  function render(container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ systemd services</span>
          <button class="btn-console btn-sm" id="svc-refresh">refresh</button>
        </div>
        <div class="panel-body scroll-x" id="svc-list">
          <span class="text-dim">loading...</span>
        </div>
      </div>
      <div class="panel hidden" id="svc-log-panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ logs: <span id="svc-log-name"></span></span>
          <button class="btn-console btn-sm" id="svc-log-close">close</button>
        </div>
        <div id="svc-log-container"></div>
      </div>`;

    document.getElementById('svc-refresh').addEventListener('click', loadServices);
    document.getElementById('svc-log-close').addEventListener('click', () => {
      document.getElementById('svc-log-panel').classList.add('hidden');
      if (logViewer) { logViewer.destroy(); logViewer = null; }
    });

    loadServices();

    wsHandler = (data) => renderList(data);
    WsClient.subscribe('services:status', wsHandler);
  }

  async function loadServices() {
    try {
      const data = await Api.get('/api/services-manager/list');
      renderList(data);
    } catch (err) {
      document.getElementById('svc-list').innerHTML = `<span class="text-err">ERR: ${err.message}</span>`;
    }
  }

  function renderList(services) {
    if (!Array.isArray(services)) return;
    const el = document.getElementById('svc-list');
    if (!el) return;

    if (services.length === 0) {
      el.innerHTML = '<span class="text-dim">no services found</span>';
      return;
    }

    const header = `<tr><th>service</th><th>status</th><th>sub</th><th>actions</th></tr>`;
    const rows = services.map(s => {
      const badge = s.active === 'active'
        ? '<span class="text-ok">[OK]</span>'
        : s.active === 'failed'
          ? '<span class="text-err">[FAIL]</span>'
          : `<span class="text-dim">[${(s.active || '--').toUpperCase()}]</span>`;

      return `<tr>
        <td>${esc(s.unit)}</td>
        <td>${badge}</td>
        <td class="text-dim">${esc(s.sub || '--')}</td>
        <td>
          <button class="btn-console btn-sm btn-ok svc-action" data-name="${esc(s.unit)}" data-action="restart">restart</button>
          <button class="btn-console btn-sm svc-action" data-name="${esc(s.unit)}" data-action="${s.active === 'active' ? 'stop' : 'start'}">${s.active === 'active' ? 'stop' : 'start'}</button>
          <button class="btn-console btn-sm svc-action" data-name="${esc(s.unit)}" data-action="logs">logs</button>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;

    el.querySelectorAll('.svc-action').forEach(btn => {
      btn.addEventListener('click', handleAction);
    });
  }

  async function handleAction(e) {
    const name = e.target.dataset.name;
    const action = e.target.dataset.action;

    if (action === 'logs') {
      // Destroy previous log viewer if any
      if (logViewer) { logViewer.destroy(); logViewer = null; }

      document.getElementById('svc-log-name').textContent = name;
      document.getElementById('svc-log-panel').classList.remove('hidden');

      const logContainer = document.getElementById('svc-log-container');
      logViewer = LogViewerWidget.create(logContainer, {
        wsChannel: 'services:logs',
        apiEndpoint: `/api/services-manager/${encodeURIComponent(name)}/logs`,
        services: [name],
        maxEntries: 2000,
        filters: { service: false, level: true, timeRange: true, search: true, lines: true },
        shortSvc: (n) => n.replace('.service', ''),
        idPrefix: 'svc-lv',
      });
      return;
    }

    if (confirmTarget === `${name}:${action}`) {
      confirmTarget = null;
      try {
        await Api.post(`/api/services-manager/${encodeURIComponent(name)}/${action}`);
        App.toast(`${action} ${name}: ok`, 'ok');
        loadServices();
      } catch (err) {
        App.toast(`ERR: ${err.message}`, 'error');
      }
      e.target.textContent = action;
      return;
    }

    confirmTarget = `${name}:${action}`;
    e.target.textContent = `[y/N] ${action}?`;
    setTimeout(() => {
      if (confirmTarget === `${name}:${action}`) {
        confirmTarget = null;
        e.target.textContent = action;
      }
    }, 3000);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function destroy() {
    if (logViewer) { logViewer.destroy(); logViewer = null; }
    if (wsHandler) {
      WsClient.unsubscribe('services:status', wsHandler);
      wsHandler = null;
    }
    confirmTarget = null;
  }

  return { render, destroy };
})();
