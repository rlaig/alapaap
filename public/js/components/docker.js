'use strict';

const DockerComponent = (() => {
  let wsHandler = null;
  let confirmTarget = null;
  let logViewer = null;

  function render(container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ docker containers</span>
          <button class="btn-console btn-sm" id="dk-refresh">refresh</button>
        </div>
        <div class="panel-body" id="dk-list" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>
      <div class="panel hidden" id="dk-log-panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ logs: <span id="dk-log-name"></span></span>
          <button class="btn-console btn-sm" id="dk-log-close">close</button>
        </div>
        <div id="dk-log-container"></div>
      </div>
      <div class="panel mt-16">
        <div class="panel-header">&gt;_ docker images</div>
        <div class="panel-body" id="dk-images" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>`;

    document.getElementById('dk-refresh').addEventListener('click', loadContainers);
    document.getElementById('dk-log-close').addEventListener('click', () => {
      document.getElementById('dk-log-panel').classList.add('hidden');
      if (logViewer) { logViewer.destroy(); logViewer = null; }
    });

    loadContainers();
    loadImages();

    wsHandler = (data) => { if (data && data.containers) renderContainers(data.containers); };
    WsClient.subscribe('docker:status', wsHandler);
  }

  async function loadContainers() {
    try {
      const data = await Api.get('/api/docker-manager/containers?all=true');
      renderContainers(data);
    } catch (err) {
      document.getElementById('dk-list').innerHTML = `<span class="text-err">ERR: ${err.message}</span>`;
    }
  }

  async function loadImages() {
    try {
      const data = await Api.get('/api/docker-manager/images');
      renderImages(data);
    } catch (err) {
      document.getElementById('dk-images').innerHTML = `<span class="text-err">ERR: ${err.message}</span>`;
    }
  }

  function renderContainers(containers) {
    const el = document.getElementById('dk-list');
    if (!el || !Array.isArray(containers)) return;

    if (containers.length === 0) {
      el.innerHTML = '<span class="text-dim">no containers</span>';
      return;
    }

    const header = '<tr><th>name</th><th>image</th><th>status</th><th>ports</th><th>actions</th></tr>';
    const rows = containers.map(c => {
      const name = (c.Names?.[0] || c.name || c.Id?.slice(0, 12) || '--').replace(/^\//, '');
      const state = (c.State || '').toLowerCase();
      const badge = state === 'running'
        ? '<span class="text-ok">[RUN]</span>'
        : state === 'exited'
          ? '<span class="text-err">[EXIT]</span>'
          : `<span class="text-dim">[${(state || 'STOP').toUpperCase()}]</span>`;

      const ports = (c.Ports || []).map(p =>
        p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}` : `${p.PrivatePort}`
      ).join(', ') || '--';

      const id = c.Id;
      const isRunning = state === 'running';

      return `<tr>
        <td>${esc(name)}</td>
        <td class="text-dim">${esc(c.Image || '--')}</td>
        <td>${badge}</td>
        <td class="text-dim">${esc(ports)}</td>
        <td>
          ${isRunning
            ? `<button class="btn-console btn-sm btn-warn dk-action" data-id="${id}" data-action="stop">stop</button>
               <button class="btn-console btn-sm dk-action" data-id="${id}" data-action="restart">restart</button>`
            : `<button class="btn-console btn-sm btn-ok dk-action" data-id="${id}" data-action="start">start</button>`}
          <button class="btn-console btn-sm dk-action" data-id="${id}" data-action="logs" data-name="${esc(name)}">logs</button>
          <button class="btn-console btn-sm btn-err dk-action" data-id="${id}" data-action="remove" data-name="${esc(name)}">rm</button>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
    el.querySelectorAll('.dk-action').forEach(btn => btn.addEventListener('click', handleAction));
  }

  function renderImages(images) {
    const el = document.getElementById('dk-images');
    if (!el || !Array.isArray(images)) return;

    const header = '<tr><th>repository</th><th>tag</th><th>size</th><th>created</th></tr>';
    const rows = images.map(img => {
      const tags = img.RepoTags || ['<none>:<none>'];
      const [repo, tag] = (tags[0] || '').split(':');
      const size = fmtB(img.Size);
      const created = new Date(img.Created * 1000).toISOString().slice(0, 10);
      return `<tr><td>${esc(repo)}</td><td class="text-dim">${esc(tag)}</td><td>${size}</td><td class="text-dim">${created}</td></tr>`;
    }).join('');

    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
  }

  async function handleAction(e) {
    const id = e.target.dataset.id;
    const action = e.target.dataset.action;
    const name = e.target.dataset.name || id?.slice(0, 12);

    if (action === 'logs') {
      if (logViewer) { logViewer.destroy(); logViewer = null; }

      document.getElementById('dk-log-name').textContent = name;
      document.getElementById('dk-log-panel').classList.remove('hidden');

      const logContainer = document.getElementById('dk-log-container');
      logViewer = LogViewerWidget.create(logContainer, {
        wsChannel: 'docker:logs',
        apiEndpoint: `/api/docker-manager/containers/${id}/logs`,
        services: [id],
        maxEntries: 2000,
        filters: { service: false, level: false, timeRange: false, search: true, lines: true },
        shortSvc: (n) => (n || '').slice(0, 12),
        idPrefix: 'dk-lv',
      });
      return;
    }

    if (action === 'remove' || action === 'stop') {
      if (confirmTarget === `${id}:${action}`) {
        confirmTarget = null;
        e.target.textContent = action === 'remove' ? 'rm' : action;
      } else {
        confirmTarget = `${id}:${action}`;
        e.target.textContent = `[y/N]?`;
        setTimeout(() => {
          if (confirmTarget === `${id}:${action}`) {
            confirmTarget = null;
            e.target.textContent = action === 'remove' ? 'rm' : action;
          }
        }, 3000);
        return;
      }
    }

    try {
      await Api.post(`/api/docker-manager/containers/${id}/${action}`);
      App.toast(`${action} ${name}: ok`, 'ok');
      loadContainers();
    } catch (err) {
      App.toast(`ERR: ${err.message}`, 'error');
    }
  }

  function fmtB(b) {
    if (!b) return '--';
    const u = ['B','K','M','G','T'];
    let i = 0, v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + u[i];
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function destroy() {
    if (logViewer) { logViewer.destroy(); logViewer = null; }
    if (wsHandler) {
      WsClient.unsubscribe('docker:status', wsHandler);
      wsHandler = null;
    }
    confirmTarget = null;
  }

  return { render, destroy };
})();
