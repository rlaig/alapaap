'use strict';

const NanobotServiceComponent = (() => {
  let wsHandler = null;
  let currentInstances = [];
  let logAutoRefresh = null;
  const LOG_AUTO_REFRESH_MS = 3000;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function render(container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ nanobot instances</span>
          <div class="flex gap-8">
            <button class="btn-console btn-sm" id="ns-show-configs">configs</button>
            <button class="btn-console btn-sm" id="ns-refresh">refresh</button>
          </div>
        </div>
        <div class="panel-body" id="ns-list" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>
      <div class="panel mt-16 hidden" id="ns-detail-panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ instance detail: <span id="ns-detail-title" class="text-dim"></span></span>
          <button class="btn-console btn-sm" id="ns-detail-close">close</button>
        </div>
        <div class="panel-body" id="ns-detail-body"></div>
      </div>
      <div class="panel mt-16 hidden" id="ns-log-panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ logs: <span id="ns-log-name"></span></span>
          <div class="flex gap-8">
            <select class="form-input ns-log-lines" id="ns-log-lines-sel">
              <option value="50">50 lines</option>
              <option value="100" selected>100 lines</option>
              <option value="200">200 lines</option>
              <option value="500">500 lines</option>
            </select>
            <button class="btn-console btn-sm" id="ns-log-refresh">refresh</button>
            <button class="btn-console btn-sm" id="ns-log-auto">auto: off</button>
            <button class="btn-console btn-sm" id="ns-log-close">close</button>
          </div>
        </div>
        <div class="log-viewer" id="ns-log-content" style="max-height:500px"></div>
      </div>
      <div class="panel mt-16 hidden" id="ns-configs-panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ available configs</span>
          <button class="btn-console btn-sm" id="ns-configs-close">close</button>
        </div>
        <div class="panel-body" id="ns-configs-body" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>`;

    document.getElementById('ns-refresh').addEventListener('click', loadInstances);
    document.getElementById('ns-detail-close').addEventListener('click', () => {
      document.getElementById('ns-detail-panel').classList.add('hidden');
    });
    document.getElementById('ns-log-close').addEventListener('click', () => {
      stopLogAutoRefresh();
      document.getElementById('ns-log-panel').classList.add('hidden');
    });
    document.getElementById('ns-log-auto').addEventListener('click', toggleLogAutoRefresh);
    document.getElementById('ns-log-refresh').addEventListener('click', () => {
      const pid = document.getElementById('ns-log-refresh').dataset.pid;
      if (pid) loadLogs(parseInt(pid, 10));
    });
    document.getElementById('ns-log-lines-sel').addEventListener('change', () => {
      const pid = document.getElementById('ns-log-refresh').dataset.pid;
      if (pid) loadLogs(parseInt(pid, 10));
    });
    document.getElementById('ns-show-configs').addEventListener('click', loadConfigs);
    document.getElementById('ns-configs-close').addEventListener('click', () => {
      document.getElementById('ns-configs-panel').classList.add('hidden');
    });

    loadInstances();

    wsHandler = (data) => {
      if (data && data.instances) renderList(data.instances);
    };
    WsClient.subscribe('nanobot-service:status', wsHandler);
  }

  async function loadInstances() {
    try {
      const data = await Api.get('/api/nanobot-service/instances');
      renderList(data);
    } catch (err) {
      document.getElementById('ns-list').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderList(instances) {
    const el = document.getElementById('ns-list');
    if (!el) return;
    if (!Array.isArray(instances)) return;

    currentInstances = instances;

    if (instances.length === 0) {
      el.innerHTML = '<span class="text-dim">no running nanobot instances</span>';
      return;
    }

    const header = `<tr>
      <th>pid</th>
      <th>mode</th>
      <th>config</th>
      <th>model</th>
      <th>channels</th>
      <th>cpu%</th>
      <th>mem</th>
      <th>uptime</th>
      <th>status</th>
      <th>actions</th>
    </tr>`;

    const rows = instances.map(i => {
      const channels = (i.enabledChannels || []).join(', ') || '--';
      return `<tr>
        <td class="text-dim">${esc(String(i.pid))}</td>
        <td>${esc(i.subcommand)}</td>
        <td>${esc(i.configName)}</td>
        <td>${esc(i.model || '--')}</td>
        <td class="text-dim">${esc(channels)}</td>
        <td>${esc(i.cpu)}%</td>
        <td>${esc(i.memMb)}M</td>
        <td class="text-dim">${esc(i.uptime)}</td>
        <td><span class="text-ok">[RUN]</span></td>
        <td>
          <button class="btn-console btn-sm ns-action" data-pid="${i.pid}" data-action="detail">detail</button>
          <button class="btn-console btn-sm ns-action" data-pid="${i.pid}" data-action="logs" data-name="${esc(i.configName)}">logs</button>
        </td>
      </tr>`;
    }).join('');

    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
    el.querySelectorAll('.ns-action').forEach(btn => btn.addEventListener('click', handleAction));
  }

  async function handleAction(e) {
    const pid = parseInt(e.target.dataset.pid, 10);
    const action = e.target.dataset.action;

    if (action === 'detail') {
      await loadDetail(pid);
    } else if (action === 'logs') {
      await loadLogs(pid);
    }
  }

  async function loadDetail(pid) {
    const titleEl = document.getElementById('ns-detail-title');
    const bodyEl = document.getElementById('ns-detail-body');
    const panel = document.getElementById('ns-detail-panel');

    titleEl.textContent = `PID ${pid}`;
    bodyEl.innerHTML = '<span class="text-dim">loading...</span>';
    panel.classList.remove('hidden');

    try {
      const data = await Api.get(`/api/nanobot-service/instances/${pid}/detail`);
      const cfg = data.config;

      let configHtml = '<span class="text-dim">config not readable</span>';
      if (cfg) {
        configHtml = `
          <table class="table-console">
            <tr><td class="text-muted" style="width:140px">model</td><td>${esc(cfg.model || '--')}</td></tr>
            <tr><td class="text-muted">provider</td><td>${esc(cfg.provider || '--')}</td></tr>
            <tr><td class="text-muted">max tokens</td><td>${esc(cfg.maxTokens != null ? String(cfg.maxTokens) : '--')}</td></tr>
            <tr><td class="text-muted">context window</td><td>${esc(cfg.contextWindow != null ? String(cfg.contextWindow) : '--')}</td></tr>
            <tr><td class="text-muted">temperature</td><td>${esc(cfg.temperature != null ? String(cfg.temperature) : '--')}</td></tr>
            <tr><td class="text-muted">workspace</td><td class="text-dim">${esc(cfg.workspace || '--')}</td></tr>
            <tr><td class="text-muted">channels</td><td>${esc((cfg.enabledChannels || []).join(', ') || 'none')}</td></tr>
          </table>`;
      }

      bodyEl.innerHTML = `
        <div class="ns-detail-grid">
          <div class="panel" style="border:none;margin:0">
            <div class="panel-header">&gt;_ process</div>
            <div class="panel-body">
              <table class="table-console">
                <tr><td class="text-muted" style="width:140px">pid</td><td>${esc(String(data.pid))}</td></tr>
                <tr><td class="text-muted">user</td><td>${esc(data.user)}</td></tr>
                <tr><td class="text-muted">subcommand</td><td>${esc(data.subcommand)}</td></tr>
                <tr><td class="text-muted">config</td><td class="text-dim">${esc(data.configPath || '--')}</td></tr>
                <tr><td class="text-muted">cpu</td><td>${esc(data.cpu)}%</td></tr>
                <tr><td class="text-muted">memory</td><td>${esc(data.memMb)} MB</td></tr>
                <tr><td class="text-muted">uptime</td><td>${esc(data.uptime)}</td></tr>
              </table>
            </div>
          </div>
          <div class="panel" style="border:none;margin:0">
            <div class="panel-header">&gt;_ config</div>
            <div class="panel-body">${configHtml}</div>
          </div>
        </div>`;
    } catch (err) {
      bodyEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function loadLogs(pid) {
    const nameEl = document.getElementById('ns-log-name');
    const contentEl = document.getElementById('ns-log-content');
    const panel = document.getElementById('ns-log-panel');
    const refreshBtn = document.getElementById('ns-log-refresh');
    const linesSel = document.getElementById('ns-log-lines-sel');

    const prevPid = refreshBtn.dataset.pid;
    const isNewInstance = !prevPid || parseInt(prevPid, 10) !== pid;
    if (isNewInstance) stopLogAutoRefresh();

    const inst = currentInstances.find(i => i.pid === pid);
    nameEl.textContent = inst ? `${inst.configName} (PID ${pid})` : `PID ${pid}`;
    refreshBtn.dataset.pid = pid;
    if (isNewInstance) contentEl.textContent = 'loading...';
    panel.classList.remove('hidden');

    try {
      const lines = linesSel.value || 100;
      const data = await Api.get(`/api/nanobot-service/instances/${pid}/logs?lines=${lines}`);
      contentEl.textContent = data.logs || '(empty)';
      contentEl.scrollTop = contentEl.scrollHeight;
    } catch (err) {
      contentEl.textContent = `ERR: ${err.message}`;
    }
  }

  async function loadConfigs() {
    const panel = document.getElementById('ns-configs-panel');
    const body = document.getElementById('ns-configs-body');
    panel.classList.remove('hidden');
    body.innerHTML = '<span class="text-dim">loading...</span>';

    try {
      const configs = await Api.get('/api/nanobot-service/configs');
      if (!configs.length) {
        body.innerHTML = '<span class="text-dim">no config files found</span>';
        return;
      }

      const runningConfigs = new Set(currentInstances.map(i => i.configPath));

      const header = '<tr><th>name</th><th>model</th><th>provider</th><th>channels</th><th>status</th></tr>';
      const rows = configs.map(c => {
        const isRunning = runningConfigs.has(c.path);
        const badge = isRunning
          ? '<span class="text-ok">[RUNNING]</span>'
          : '<span class="text-dim">[STOPPED]</span>';
        const channels = (c.enabledChannels || []).join(', ') || '--';
        return `<tr>
          <td>${esc(c.name)}</td>
          <td>${esc(c.model || '--')}</td>
          <td class="text-dim">${esc(c.provider || '--')}</td>
          <td class="text-dim">${esc(channels)}</td>
          <td>${badge}</td>
        </tr>`;
      }).join('');

      body.innerHTML = `<table class="table-console">${header}${rows}</table>`;
    } catch (err) {
      body.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function toggleLogAutoRefresh() {
    const btn = document.getElementById('ns-log-auto');
    if (logAutoRefresh) {
      stopLogAutoRefresh();
    } else {
      const pid = document.getElementById('ns-log-refresh').dataset.pid;
      if (!pid) return;
      btn.textContent = 'auto: on';
      btn.classList.add('btn-ok');
      logAutoRefresh = setInterval(() => {
        const curPid = document.getElementById('ns-log-refresh').dataset.pid;
        if (curPid) loadLogs(parseInt(curPid, 10));
      }, LOG_AUTO_REFRESH_MS);
    }
  }

  function stopLogAutoRefresh() {
    if (logAutoRefresh) {
      clearInterval(logAutoRefresh);
      logAutoRefresh = null;
    }
    const btn = document.getElementById('ns-log-auto');
    if (btn) {
      btn.textContent = 'auto: off';
      btn.classList.remove('btn-ok');
    }
  }

  function destroy() {
    stopLogAutoRefresh();
    if (wsHandler) {
      WsClient.unsubscribe('nanobot-service:status', wsHandler);
      wsHandler = null;
    }
    currentInstances = [];
  }

  return { render, destroy };
})();
