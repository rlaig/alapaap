'use strict';

/**
 * Docker control panel.
 *
 * Shell with five tabs (containers / images / volumes / networks / system) plus
 * two shared overlays that live above the tabs:
 *   - #dk-detail-overlay : container inspector drawer (env, ports, mounts, ...)
 *   - #dk-term-overlay    : interactive `docker exec` terminal (xterm.js)
 *
 * The terminal speaks to src/modules/docker-manager/exec-bridge.js over the
 * shared WebSocket using base64 pty payloads (see public/js/lib/ws-client.js
 * send / onMessage).
 */
const DockerComponent = (() => {
  const API = '/api/docker-manager';
  let currentView = null;
  let currentTab = 'containers';
  let execConfig = { enabled: true, defaultUser: 'root', defaultShell: '/bin/sh', allowedShells: ['/bin/sh'] };
  let reconnectCb = null;

  // shared overlay state
  let detailState = null; // { id, name, statsTimer, inspect }
  let termState = null;   // { term, fit, execId, containerId, attached, handlers, ro, resizeCb }

  // ─── helpers ───
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtB(b) {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return '0';
    const u = ['B', 'K', 'M', 'G', 'T', 'P'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + u[i];
  }
  function fmtDate(s) {
    if (!s) return '--';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? esc(s) : d.toISOString().slice(0, 19).replace('T', ' ');
  }
  function shortId(id) { return (id || '').replace(/^sha256:/, '').slice(0, 12); }
  function refEncode(ref) { return encodeURIComponent(ref); }

  // two-click confirm: keyed "target:action" with 3s timeout
  const confirmTargets = new Map(); // key -> { btn, timeout, origText }
  function armConfirm(key, btn, label) {
    if (confirmTargets.has(key)) return true; // already armed -> confirmed
    confirmTargets.set(key, {
      btn,
      origText: btn.textContent,
      timeout: setTimeout(() => {
        const c = confirmTargets.get(key);
        if (c) { c.btn.textContent = c.origText; confirmTargets.delete(key); }
      }, 3000),
    });
    btn.textContent = label;
    return false;
  }
  function clearConfirm(key) {
    const c = confirmTargets.get(key);
    if (c) { clearTimeout(c.timeout); c.btn.textContent = c.origText; confirmTargets.delete(key); }
  }

  // button pending state: disables + swaps text while an async action is in-flight
  const pendingBtns = new Map(); // btn element -> { origText }
  function setBtnPending(btn, label) {
    if (!btn || pendingBtns.has(btn)) return;
    pendingBtns.set(btn, { origText: btn.textContent });
    btn.disabled = true;
    btn.textContent = label;
  }
  function clearBtnPending(btn) {
    if (!btn) return;
    const s = pendingBtns.get(btn);
    if (s) { btn.textContent = s.origText; btn.disabled = false; pendingBtns.delete(btn); }
  }

  // ─── shell ───
  function render(container) {
    container.innerHTML = `
      <div class="bt-tabs" id="dk-tabs">
        <button class="bt-tab bt-tab-active" data-tab="containers">&gt;_ containers</button>
        <button class="bt-tab" data-tab="images">&gt;_ images</button>
        <button class="bt-tab" data-tab="volumes">&gt;_ volumes</button>
        <button class="bt-tab" data-tab="networks">&gt;_ networks</button>
        <button class="bt-tab" data-tab="system">&gt;_ system</button>
      </div>
      <div id="dk-tab-content"></div>

      <div id="dk-detail-overlay" class="dk-overlay hidden">
        <div class="dk-drawer">
          <div class="dk-drawer-head">
            <span class="text-dim" id="dk-detail-title">&gt;_ container</span>
            <span id="dk-detail-actions" class="dk-actions"></span>
            <button class="btn-console btn-sm" id="dk-detail-close">close</button>
          </div>
          <div class="dk-drawer-body" id="dk-detail-body"></div>
        </div>
      </div>

      <div id="dk-term-overlay" class="dk-term-overlay hidden">
        <div class="dk-term">
          <div class="dk-term-head">
            <span class="text-dim" id="dk-term-title">&gt;_ exec</span>
            <span class="dk-term-prompt">
              <label class="text-muted">shell</label>
              <select id="dk-term-shell"></select>
              <label class="text-muted">user</label>
              <input id="dk-term-user" style="width:90px" autocomplete="off">
              <button class="btn-console btn-sm btn-ok" id="dk-term-connect">connect</button>
            </span>
            <button class="btn-console btn-sm btn-err" id="dk-term-close">close</button>
          </div>
          <div class="dk-term-body" id="dk-term-body"></div>
        </div>
      </div>`;

    container.querySelector('#dk-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });
    container.querySelector('#dk-detail-close').addEventListener('click', closeDetail);
    container.querySelector('#dk-detail-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'dk-detail-overlay') closeDetail();
    });
    container.querySelector('#dk-term-close').addEventListener('click', closeTerminal);
    container.querySelector('#dk-term-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'dk-term-overlay') closeTerminal();
    });
    container.querySelector('#dk-term-connect').addEventListener('click', () => {
      if (termState?.containerId) terminalConnect(termState.containerId, termState.name);
    });

    // load exec config (controls whether the terminal button appears)
    Api.get(`${API}/exec/config`).then((cfg) => { execConfig = cfg || execConfig; }).catch(() => {});

    reconnectCb = () => {
      if (termState?.attached) {
        App.toast('connection lost — terminal closed', 'warn');
        resetTerminalToPrompt();
      }
    };
    WsClient.onReconnect(reconnectCb);

    switchTab('containers');
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#dk-tabs .bt-tab').forEach((t) =>
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab));
    if (currentView && currentView.destroy) currentView.destroy();
    const content = document.getElementById('dk-tab-content');
    content.innerHTML = '';
    const views = { containers: ContainersView, images: ImagesView, volumes: VolumesView, networks: NetworksView, system: SystemView };
    currentView = views[tab];
    currentView.render(content);
  }

  function destroy() {
    if (currentView && currentView.destroy) currentView.destroy();
    currentView = null;
    closeDetail();
    closeTerminal();
    if (reconnectCb) { WsClient.offReconnect(reconnectCb); reconnectCb = null; }
    for (const key of Array.from(confirmTargets.keys())) clearConfirm(key);
  }

  // ─── container detail drawer ───
  function openDetail(id, name) {
    closeDetail();
    detailState = { id, name: name || id.slice(0, 12), statsTimer: null, inspect: null };
    document.getElementById('dk-detail-title').textContent = `>_ ${detailState.name}`;
    document.getElementById('dk-detail-body').innerHTML = '<span class="text-dim">loading...</span>';
    document.getElementById('dk-detail-overlay').classList.remove('hidden');
    loadDetail();
  }

  async function loadDetail() {
    const id = detailState?.id;
    try {
      const data = await Api.get(`${API}/containers/${refEncode(detailState.id)}`);
      if (!detailState || detailState.id !== id) return; // closed/changed while loading
      detailState.inspect = data;
      renderDetailActions();
      renderDetailBody();
      detailState.statsTimer = setInterval(pollDetailStats, 2000);
      pollDetailStats();
    } catch (err) {
      if (!detailState || detailState.id !== id) return;
      document.getElementById('dk-detail-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function closeDetail() {
    if (detailState?.statsTimer) { clearInterval(detailState.statsTimer); }
    detailState = null;
    if (logViewer) { logViewer.destroy(); logViewer = null; }
    const el = document.getElementById('dk-detail-overlay');
    if (el) el.classList.add('hidden');
  }

  function renderDetailActions() {
    const d = detailState.inspect;
    const running = d?.State?.Running;
    const paused = d?.State?.Paused;
    const el = document.getElementById('dk-detail-actions');
    let btns = '';
    if (running && !paused) btns += `<button class="btn-console btn-sm btn-warn dk-da" data-action="stop">stop</button>`;
    if (paused) btns += `<button class="btn-console btn-sm btn-ok dk-da" data-action="unpause">unpause</button>`;
    if (!running) btns += `<button class="btn-console btn-sm btn-ok dk-da" data-action="start">start</button>`;
    btns += `<button class="btn-console btn-sm dk-da" data-action="restart">restart</button>`;
    btns += `<button class="btn-console btn-sm dk-da" data-action="logs">logs</button>`;
    if (running && !paused && execConfig.enabled) btns += `<button class="btn-console btn-sm dk-da" data-action="terminal">term</button>`;
    el.innerHTML = btns;
    el.querySelectorAll('.dk-da').forEach((b) => b.addEventListener('click', (e) => detailAction(e.target.dataset.action)));
  }

  function detailAction(action) {
    const id = detailState.id;
    const name = detailState.name;
    if (action === 'logs') { openContainerLogs(id, name); return; }
    if (action === 'terminal') { openTerminal(id, name); return; }
    if (action === 'remove') { /* handled with confirm below */ }
    const btn = document.querySelector(`.dk-da[data-action="${action}"]`);
    doContainerAction(id, name, action, { btn, refresh: () => loadDetail() });
  }

  function renderDetailBody() {
    const d = detailState.inspect;
    const env = (d?.Config?.Env || []).map((e) => {
      const i = e.indexOf('=');
      return i >= 0 ? [e.slice(0, i), e.slice(i + 1)] : [e, ''];
    });
    const ports = d?.NetworkSettings?.Ports || d?.HostConfig?.PortBindings || {};
    const portRows = Object.entries(ports).map(([k, v]) => {
      const binds = (v || []).map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ') || '--';
      return `<div class="dk-kv"><span class="dk-k">${esc(k)}</span><span class="dk-v">${esc(binds)}</span></div>`;
    }).join('') || '<span class="text-dim">--</span>';
    const mounts = (d?.Mounts || []).map((m) =>
      `<div class="dk-kv"><span class="dk-k">${esc(m.Destination || m.Name || '--')}</span><span class="dk-v">${esc(m.Source || m.Name || '')} <span class="text-muted">[${esc(m.Type)}]</span></span></div>`
    ).join('') || '<span class="text-dim">--</span>';
    const nets = Object.entries(d?.NetworkSettings?.Networks || {}).map(([k, v]) =>
      `<div class="dk-kv"><span class="dk-k">${esc(k)}</span><span class="dk-v">${esc(v.IPAddress || '--')}</span></div>`
    ).join('') || '<span class="text-dim">--</span>';
    const labels = Object.entries(d?.Config?.Labels || {}).map(([k, v]) =>
      `<div class="dk-kv"><span class="dk-k">${esc(k)}</span><span class="dk-v">${esc(v)}</span></div>`
    ).join('') || '<span class="text-dim">--</span>';
    const rp = d?.HostConfig?.RestartPolicy || {};
    const cmd = (d?.Config?.Cmd || []).join(' ');
    const entry = (d?.Config?.Entrypoint || []).join(' ');

    document.getElementById('dk-detail-body').innerHTML = `
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ overview</div>
        <div class="dk-kv">
          <span class="dk-k">id</span><span class="dk-v">${esc(shortId(d?.Id))}</span>
          <span class="dk-k">image</span><span class="dk-v">${esc(d?.Config?.Image || d?.Image || '--')}</span>
          <span class="dk-k">created</span><span class="dk-v">${fmtDate(d?.Created)}</span>
          <span class="dk-k">state</span><span class="dk-v">${esc(d?.State?.Status || '--')} ${d?.State?.Running ? '<span class="text-ok">[RUN]</span>' : '<span class="text-err">[STOP]</span>'}</span>
          <span class="dk-k">pid</span><span class="dk-v">${esc(d?.State?.Pid ?? '--')}</span>
          <span class="dk-k">hostname</span><span class="dk-v">${esc(d?.Config?.Hostname || '--')}</span>
          <span class="dk-k">entrypoint</span><span class="dk-v">${esc(entry || '--')}</span>
          <span class="dk-k">command</span><span class="dk-v">${esc(cmd || '--')}</span>
          <span class="dk-k">restart</span><span class="dk-v">${esc(rp.Name || '--')}${rp.MaximumRetryCount ? ` (max ${rp.MaximumRetryCount})` : ''}</span>
        </div>
        <div class="dk-stats" id="dk-detail-stats" style="margin-top:8px"></div>
      </div>
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ environment</div>
        ${env.length ? env.map(([k, v]) => `<div class="dk-kv"><span class="dk-k">${esc(k)}</span><span class="dk-v">${esc(v)}</span></div>`).join('') : '<span class="text-dim">--</span>'}
      </div>
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ ports</div>
        ${portRows}
      </div>
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ mounts</div>
        ${mounts}
      </div>
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ networks</div>
        ${nets}
      </div>
      <div class="dk-section">
        <div class="dk-section-title">&gt;_ labels</div>
        ${labels}
      </div>`;
  }

  async function pollDetailStats() {
    if (!detailState) return;
    const el = document.getElementById('dk-detail-stats');
    if (!el) return;
    try {
      const data = await Api.get(`${API}/containers/${refEncode(detailState.id)}/stats`);
      renderStatsRow(el, data.compact);
    } catch { /* keep last */ }
  }

  function renderStatsRow(el, s) {
    if (!s) { el.innerHTML = '<span class="text-dim">stats: --</span>'; return; }
    el.innerHTML = `
      <span class="dk-stat"><span class="dk-stat-label">cpu</span><span class="dk-stat-val">${s.cpuPct == null ? '--' : s.cpuPct + '%'}</span></span>
      <span class="dk-stat"><span class="dk-stat-label">mem</span><span class="dk-stat-val">${fmtB(s.memUsed)}/${fmtB(s.memLimit)}${s.memPct == null ? '' : ' (' + s.memPct + '%)'}</span></span>
      <span class="dk-stat"><span class="dk-stat-label">net</span><span class="dk-stat-val">${fmtB(s.netRx)}↓ ${fmtB(s.netTx)}↑</span></span>
      <span class="dk-stat"><span class="dk-stat-label">io</span><span class="dk-stat-val">${fmtB(s.blkRead)}↑ ${fmtB(s.blkWrite)}↓</span></span>`;
  }

  // ─── terminal (docker exec) ───
  function openTerminal(id, name) {
    if (!execConfig.enabled) { App.toast('exec is disabled', 'warn'); return; }
    if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
      App.toast('terminal library not loaded', 'error'); return;
    }
    closeTerminal();
    termState = { term: null, fit: null, execId: null, containerId: id, name: name || id.slice(0, 12), attached: false, handlers: [], ro: null, resizeCb: null };
    document.getElementById('dk-term-title').textContent = `>_ exec: ${termState.name}`;
    const shellSel = document.getElementById('dk-term-shell');
    shellSel.innerHTML = (execConfig.allowedShells || ['/bin/sh']).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    shellSel.value = execConfig.defaultShell || (execConfig.allowedShells || ['/bin/sh'])[0];
    document.getElementById('dk-term-user').value = execConfig.defaultUser || 'root';
    document.getElementById('dk-term-body').innerHTML = '<span class="text-dim" style="display:block;padding:8px">click connect to open a session</span>';
    document.getElementById('dk-term-connect').disabled = false;
    document.getElementById('dk-term-connect').textContent = 'connect';
    document.getElementById('dk-term-overlay').classList.remove('hidden');
  }

  function terminalConnect(id, name) {
    if (!termState) return;
    const shell = document.getElementById('dk-term-shell').value;
    const user = document.getElementById('dk-term-user').value.trim() || 'root';
    const body = document.getElementById('dk-term-body');
    body.innerHTML = ''; // clear prompt hint
    const term = new Terminal({ fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: THEME.bgPrimary, foreground: THEME.textBright, cursor: THEME.green } });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(body);
    try { fit.fit(); } catch { /* layout not ready */ }
    term.write(`\x1b[36mconnecting to ${name} as ${user} via ${shell}...\x1b[0m\r\n`);
    term.focus();

    const execId = 'dk-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    termState.term = term;
    termState.fit = fit;
    termState.execId = execId;
    termState.attached = false;
    document.getElementById('dk-term-connect').disabled = true;

    // input -> server (base64 over utf-8)
    const dataDisp = term.onData((str) => {
      if (!termState.attached) return;
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      WsClient.send({ type: 'exec:input', execId, data: btoa(bin) });
    });

    function b64ToUint8(b64) {
      const bin = atob(b64 || '');
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    const onOutput = (m) => { if (m.execId === execId) term.write(b64ToUint8(m.data)); };
    const onReady = (m) => {
      if (m.execId !== execId) return;
      termState.attached = true;
      try { fit.fit(); } catch {}
      sendResize();
      term.focus();
    };
    const onExit = (m) => {
      if (m.execId !== execId) return;
      term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n');
      App.toast('terminal session ended', 'warn');
      resetTerminalToPrompt();
    };
    const onError = (m) => {
      if (m.execId !== execId) return;
      term.write(`\r\n\x1b[31mERR: ${esc(m.message)}\x1b[0m\r\n`);
      App.toast(`exec: ${m.message}`, 'error');
      resetTerminalToPrompt();
    };
    WsClient.onMessage('exec:output', onOutput);
    WsClient.onMessage('exec:ready', onReady);
    WsClient.onMessage('exec:exit', onExit);
    WsClient.onMessage('exec:error', onError);
    termState.handlers = [
      ['exec:output', onOutput], ['exec:ready', onReady], ['exec:exit', onExit], ['exec:error', onError],
    ];
    termState.dataDisp = dataDisp;

    function sendResize() {
      try {
        WsClient.send({ type: 'exec:resize', execId, cols: term.cols, rows: term.rows });
      } catch { /* ignore */ }
    }
    termState.resizeCb = sendResize;
    window.addEventListener('resize', sendResize);
    if (window.ResizeObserver) {
      termState.ro = new ResizeObserver(() => { try { fit.fit(); } catch {} sendResize(); });
      termState.ro.observe(body);
    }

    // attach (must be authed+open)
    const ok = WsClient.send({ type: 'exec:attach', execId, containerId: id, cmd: [shell], user, cols: term.cols, rows: term.rows });
    if (!ok) {
      term.write('\r\n\x1b[31mnot connected — retry\x1b[0m\r\n');
      resetTerminalToPrompt();
    }
  }

  function resetTerminalToPrompt() {
    if (!termState) return;
    teardownTermState();
    const body = document.getElementById('dk-term-body');
    if (body) body.innerHTML = '<span class="text-dim" style="display:block;padding:8px">session closed — click connect to reopen</span>';
    const btn = document.getElementById('dk-term-connect');
    if (btn) { btn.disabled = false; btn.textContent = 'connect'; }
  }

  function teardownTermState() {
    if (!termState) return;
    for (const [type, cb] of (termState.handlers || [])) WsClient.offMessage(type, cb);
    if (termState.dataDisp) { try { termState.dataDisp.dispose(); } catch {} }
    if (termState.resizeCb) window.removeEventListener('resize', termState.resizeCb);
    if (termState.ro) { try { termState.ro.disconnect(); } catch {} }
    if (termState.execId && termState.attached) {
      try { WsClient.send({ type: 'exec:detach', execId: termState.execId }); } catch {}
    }
    if (termState.term) { try { termState.term.dispose(); } catch {} }
    termState.attached = false;
    termState.term = null;
    termState.fit = null;
    termState.execId = null;
  }

  function closeTerminal() {
    teardownTermState();
    termState = null;
    const el = document.getElementById('dk-term-overlay');
    if (el) el.classList.add('hidden');
  }

  // ─── container logs (existing LogViewerWidget) ───
  let logViewer = null;
  function openContainerLogs(id, name) {
    if (logViewer) { logViewer.destroy(); logViewer = null; }
    closeDetail();
    detailState = { id, name: name || id.slice(0, 12), statsTimer: null };
    document.getElementById('dk-detail-title').textContent = `>_ logs: ${detailState.name}`;
    document.getElementById('dk-detail-actions').innerHTML = '';
    const body = document.getElementById('dk-detail-body');
    body.innerHTML = '';
    const wrap = document.createElement('div');
    body.appendChild(wrap);
    document.getElementById('dk-detail-overlay').classList.remove('hidden');
    logViewer = LogViewerWidget.create(wrap, {
      wsChannel: 'docker:logs',
      apiEndpoint: `${API}/containers/${refEncode(id)}/logs`,
      services: [id],
      maxEntries: 2000,
      filters: { service: false, level: false, timeRange: false, search: true, lines: true },
      shortSvc: (n) => (n || '').slice(0, 12),
      idPrefix: 'dk-lv',
    });
  }

  // ─── shared container action runner (used by list + detail) ───
  const pending = new Set();
  async function doContainerAction(id, name, action, opts = {}) {
    const key = `${id}:${action}`;
    if (action === 'remove' || action === 'stop') {
      if (!opts.confirmed) {
        const btn = opts.btn;
        if (btn && !armConfirm(`${key}:confirm`, btn, '[y/N]?')) return;
      }
    }
    if (opts.btn) setBtnPending(opts.btn, `${action}ing…`);
    pending.add(key);
    try {
      await Api.post(`${API}/containers/${refEncode(id)}/${action}`, opts.body || {});
      App.toast(`${action} ${name}: ok`, 'ok');
    } catch (err) {
      if (opts.btn) clearBtnPending(opts.btn);
      App.toast(`ERR ${action}: ${err.message}`, 'error');
    } finally {
      pending.delete(key);
      clearConfirm(`${key}:confirm`);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Containers view
  // ════════════════════════════════════════════════════════════════════
  const ContainersView = (() => {
    let wsHandler = null;
    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ containers</span>
            <button class="btn-console btn-sm" id="dk-c-refresh">refresh</button>
          </div>
          <div class="panel-body scroll-x" id="dk-c-list"><span class="text-dim">loading...</span></div>
        </div>`;
      container.querySelector('#dk-c-refresh').addEventListener('click', () => load([]));
      wsHandler = (data) => { if (data && Array.isArray(data.containers)) renderList(data.containers); };
      WsClient.subscribe('docker:status', wsHandler);
    }
    async function load() { /* ws drives updates; initial fetch for snappiness */ }
    function renderList(containers) {
      const el = document.getElementById('dk-c-list');
      if (!el) return;
      if (!containers.length) { el.innerHTML = '<span class="text-dim">no containers</span>'; return; }
      const header = '<tr><th>name</th><th>image</th><th>status</th><th>ports</th><th>stats</th><th>actions</th></tr>';
      const rows = containers.map((c) => {
        const name = (c.Names?.[0] || c.name || shortId(c.Id)).replace(/^\//, '');
        const state = (c.State || '').toLowerCase();
        const badge = state === 'running' ? '<span class="text-ok">[RUN]</span>'
          : state === 'exited' ? '<span class="text-err">[EXIT]</span>'
          : state === 'paused' ? '<span class="text-warn">[PAUSE]</span>'
          : `<span class="text-dim">[${esc((state || 'STOP').toUpperCase())}]</span>`;
        const ports = (c.Ports || []).map((p) => p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}` : `${p.PrivatePort}`).join(', ') || '--';
        const id = c.Id;
        const running = state === 'running';
        const paused = state === 'paused';
        let a = '';
        if (running && !paused) a += `<button class="btn-console btn-sm btn-warn dk-act" data-id="${esc(id)}" data-action="stop" data-name="${esc(name)}">stop</button>`;
        if (paused) a += `<button class="btn-console btn-sm btn-ok dk-act" data-id="${esc(id)}" data-action="unpause" data-name="${esc(name)}">unpause</button>`;
        if (!running) a += `<button class="btn-console btn-sm btn-ok dk-act" data-id="${esc(id)}" data-action="start" data-name="${esc(name)}">start</button>`;
        a += `<button class="btn-console btn-sm dk-act" data-id="${esc(id)}" data-action="restart" data-name="${esc(name)}">restart</button>`;
        if (running && !paused) a += `<button class="btn-console btn-sm dk-act" data-id="${esc(id)}" data-action="terminal" data-name="${esc(name)}">term</button>`;
        a += `<button class="btn-console btn-sm dk-act" data-id="${esc(id)}" data-action="logs" data-name="${esc(name)}">logs</button>`;
        a += `<button class="btn-console btn-sm btn-err dk-act" data-id="${esc(id)}" data-action="remove" data-name="${esc(name)}">rm</button>`;
        const stats = c.stats ? `<span class="dk-cell-stats">${c.stats.cpuPct == null ? '--' : esc(c.stats.cpuPct + '%')} · ${fmtB(c.stats.memUsed)}</span>` : '<span class="text-muted">--</span>';
        return `<tr>
          <td><a class="dk-open cursor-pointer" data-id="${esc(id)}" data-name="${esc(name)}">${esc(name)}</a></td>
          <td class="text-dim">${esc(c.Image || '--')}</td>
          <td>${badge} <span class="text-muted">${esc(c.Status || '')}</span></td>
          <td class="text-dim">${esc(ports)}</td>
          <td>${stats}</td>
          <td><div class="dk-actions">${a}</div></td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      el.querySelectorAll('.dk-act').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAct(e.target);
      }));
      el.querySelectorAll('.dk-open').forEach((a) => a.addEventListener('click', (e) => {
        const t = e.target; openDetail(t.dataset.id, t.dataset.name);
      }));
    }
    function handleAct(btn) {
      const { id, action, name } = btn.dataset;
      if (action === 'logs') { openContainerLogs(id, name); return; }
      if (action === 'terminal') { openTerminal(id, name); return; }
      doContainerAction(id, name, action, { btn, body: action === 'remove' ? { force: true } : {} });
    }
    function refresh() { /* ws-driven */ }
    function destroy() { if (wsHandler) { WsClient.unsubscribe('docker:status', wsHandler); wsHandler = null; } }
    return { render, destroy, refresh };
  })();

  // ════════════════════════════════════════════════════════════════════
  //  Images view
  // ════════════════════════════════════════════════════════════════════
  const ImagesView = (() => {
    let pullHandler = null;
    let pulls = new Map(); // ref -> { layers:Map, summary, statuses, done, error }
    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header">&gt;_ images</div>
          <div class="panel-body">
            <div class="dk-toolbar">
              <input class="form-input" id="dk-i-pullref" placeholder="image:tag (e.g. alpine:3)" autocomplete="off">
              <button class="btn-console btn-sm btn-ok" id="dk-i-pull">pull</button>
              <button class="btn-console btn-sm btn-warn" id="dk-i-prune">prune dangling</button>
              <button class="btn-console btn-sm" id="dk-i-refresh">refresh</button>
            </div>
            <div class="dk-pull-panel hidden" id="dk-i-pullpanel"></div>
            <div id="dk-i-list" class="scroll-x"><span class="text-dim">loading...</span></div>
          </div>
        </div>`;
      container.querySelector('#dk-i-pull').addEventListener('click', doPull);
      container.querySelector('#dk-i-pullref').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPull(); });
      container.querySelector('#dk-i-prune').addEventListener('click', pruneDangling);
      container.querySelector('#dk-i-refresh').addEventListener('click', loadList);
      pullHandler = (m) => { if (m && m.ref) onPullEvent(m); };
      WsClient.subscribe('docker:image-pull', pullHandler);
      loadList();
    }
    async function loadList() {
      try {
        const images = await Api.get(`${API}/images`);
        renderList(images);
      } catch (err) {
        document.getElementById('dk-i-list').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      }
    }
    function renderList(images) {
      const el = document.getElementById('dk-i-list');
      if (!el) return;
      if (!images.length) { el.innerHTML = '<span class="text-dim">no images</span>'; return; }
      const header = '<tr><th>repository</th><th>tag</th><th>id</th><th>size</th><th>created</th><th>actions</th></tr>';
      const rows = images.map((img) => {
        const tags = img.RepoTags || [];
        const repoTag = tags[0] || '<none>:<none>';
        const i = repoTag.lastIndexOf(':');
        const repo = i > 0 ? repoTag.slice(0, i) : repoTag;
        const tag = i > 0 ? repoTag.slice(i + 1) : '';
        const id = shortId(img.Id);
        const ref = tags[0] || img.Id;
        let a = `<button class="btn-console btn-sm dk-act" data-ref="${esc(refEncode(ref))}" data-name="${esc(repoTag)}" data-action="inspect">info</button>`;
        if (tags[0]) a += `<button class="btn-console btn-sm dk-act" data-ref="${esc(refEncode(ref))}" data-name="${esc(repoTag)}" data-action="check">check</button>`;
        a += `<button class="btn-console btn-sm btn-err dk-act" data-ref="${esc(refEncode(ref))}" data-name="${esc(repoTag)}" data-action="remove">rm</button>`;
        return `<tr>
          <td>${esc(repo)}</td>
          <td class="text-dim">${esc(tag)}</td>
          <td class="text-muted">${esc(id)}</td>
          <td>${fmtB(img.Size)}</td>
          <td class="text-dim">${fmtDate(new Date((img.Created || 0) * 1000).toISOString())}</td>
          <td><div class="dk-actions">${a}</div></td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      el.querySelectorAll('.dk-act').forEach((b) => b.addEventListener('click', (e) => handleAct(e.target)));
    }
    async function doPull() {
      const ref = document.getElementById('dk-i-pullref').value.trim();
      if (!ref) return;
      const idx = ref.lastIndexOf(':');
      let name = ref, tag = '';
      if (idx > 0 && !ref.slice(idx + 1).includes('/')) { name = ref.slice(0, idx); tag = ref.slice(idx + 1); }
      try {
        await Api.post(`${API}/images/pull`, { name, tag });
        document.getElementById('dk-i-pullpanel').classList.remove('hidden');
        document.getElementById('dk-i-pullref').value = '';
        App.toast(`pulling ${ref}...`, 'ok');
      } catch (err) { App.toast(`pull: ${err.message}`, 'error'); }
    }
    function onPullEvent(m) {
      const ref = m.ref;
      if (!pulls.has(ref)) pulls.set(ref, { layers: new Map(), statuses: [], done: false, error: null });
      const st = pulls.get(ref);
      if (Array.isArray(m.layers)) { for (const l of m.layers) st.layers.set(l.id, l); }
      if (Array.isArray(m.statuses)) st.statuses = m.statuses;
      if (m.event === 'error') st.error = m.message;
      if (m.event === 'done') { st.done = true; st.upToDate = m.upToDate; st.updated = m.updated; }
      renderPullPanel();
      if (m.event === 'done') {
        App.toast(`${ref}: ${m.updated ? 'updated' : m.upToDate ? 'up to date' : 'done'}`, m.updated || m.upToDate ? 'ok' : 'warn');
        setTimeout(loadList, 500);
      } else if (m.event === 'error') {
        App.toast(`${ref}: ${m.message}`, 'error');
      }
    }
    function renderPullPanel() {
      const el = document.getElementById('dk-i-pullpanel');
      if (!el) return;
      if (!pulls.size) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const blocks = Array.from(pulls.entries()).map(([ref, st]) => {
        const rows = Array.from(st.layers.values()).map((l) => {
          const pct = (l.total && typeof l.current === 'number') ? Math.min(100, Math.round((l.current / l.total) * 100)) : null;
          return `<div class="dk-pull-row"><span class="text-muted">${esc((l.id || '').slice(0, 12))}</span><span>${esc(l.status || '')} ${l.progress ? '<span class="text-muted">' + esc(l.progress) + '</span>' : ''}</span><span>${pct == null ? '' : pct + '%'}</span></div>`;
        }).join('');
        const s = st.summary || {};
        const overall = st.done
          ? (st.error ? `<span class="text-err">error: ${esc(st.error)}</span>` : (st.updated ? '<span class="text-ok">updated</span>' : st.upToDate ? '<span class="text-ok">up to date</span>' : '<span class="text-dim">done</span>'))
          : (s.percent == null ? '<span class="text-dim">working...</span>' : `<span class="text-bright">${s.percent}%</span> <span class="text-muted">(${fmtB(s.current)}/${fmtB(s.total)})</span>`);
        return `<div class="dk-pull-ref">&gt;_ ${esc(ref)}</div>${rows}<div class="dk-pull-overall">${overall}</div>`;
      }).join('');
      el.innerHTML = blocks;
    }
    function handleAct(btn) {
      const ref = decodeURIComponent(btn.dataset.ref);
      const name = btn.dataset.name;
      const action = btn.dataset.action;
      if (action === 'inspect') { openImageDetail(ref, name); return; }
      if (action === 'check') { doCheck(ref); return; }
      if (action === 'remove') {
        if (!armConfirm(`img:${ref}:rm`, btn, '[y/N]?')) return;
        setBtnPending(btn, 'removing…');
        Api.delete(`${API}/images/${refEncode(ref)}`, { force: true }).then(() => {
          App.toast(`removed ${name}`, 'ok'); clearConfirm(`img:${ref}:rm`); loadList();
        }).catch((err) => { clearBtnPending(btn); App.toast(`rm: ${err.message}`, 'error'); clearConfirm(`img:${ref}:rm`); });
      }
    }
    async function doCheck(ref) {
      try {
        await Api.post(`${API}/images/check-update`, { ref });
        document.getElementById('dk-i-pullpanel').classList.remove('hidden');
        App.toast(`checking ${ref}...`, 'ok');
      } catch (err) { App.toast(`check: ${err.message}`, 'error'); }
    }
    async function pruneDangling() {
      if (!confirm('Prune dangling images?')) return;
      const pruneBtn = document.getElementById('dk-i-prune');
      setBtnPending(pruneBtn, 'pruning…');
      try {
        const r = await Api.post(`${API}/images/prune`, {});
        App.toast(`pruned images${r?.SpaceReclaimed ? ' (' + fmtB(r.SpaceReclaimed) + ')' : ''}`, 'ok');
        loadList();
      } catch (err) { App.toast(`prune: ${err.message}`, 'error'); }
      finally { clearBtnPending(pruneBtn); }
    }
    function destroy() { if (pullHandler) { WsClient.unsubscribe('docker:image-pull', pullHandler); pullHandler = null; } }
    function refresh() { loadList(); }
    return { render, destroy, refresh };
  })();

  // image inspect reuses the detail drawer with a custom render
  async function openImageDetail(ref, name) {
    closeDetail();
    detailState = { id: ref, name: name || ref, statsTimer: null, isImage: true };
    document.getElementById('dk-detail-title').textContent = `>_ image: ${detailState.name}`;
    document.getElementById('dk-detail-actions').innerHTML = '';
    document.getElementById('dk-detail-body').innerHTML = '<span class="text-dim">loading...</span>';
    document.getElementById('dk-detail-overlay').classList.remove('hidden');
    try {
      const img = await Api.get(`${API}/images/${refEncode(ref)}`);
      const cfg = img.Config || {};
      const env = (cfg.Env || []).map((e) => { const i = e.indexOf('='); return i >= 0 ? [e.slice(0, i), e.slice(i + 1)] : [e, '']; });
      document.getElementById('dk-detail-body').innerHTML = `
        <div class="dk-section"><div class="dk-section-title">&gt;_ overview</div>
          <div class="dk-kv">
            <span class="dk-k">id</span><span class="dk-v">${esc(shortId(img.Id))}</span>
            <span class="dk-k">tags</span><span class="dk-v">${(img.RepoTags || []).map((t) => `<span class="dk-pill">${esc(t)}</span>`).join('') || '--'}</span>
            <span class="dk-k">size</span><span class="dk-v">${fmtB(img.Size)} / ${fmtB(img.VirtualSize || img.Size)} virt</span>
            <span class="dk-k">created</span><span class="dk-v">${fmtDate(img.Created)}</span>
            <span class="dk-k">arch</span><span class="dk-v">${esc(cfg.Architecture || img.Architecture || '--')}/${esc(cfg.Os || img.Os || '--')}</span>
            <span class="dk-k">entrypoint</span><span class="dk-v">${esc((cfg.Entrypoint || []).join(' ') || '--')}</span>
            <span class="dk-k">command</span><span class="dk-v">${esc((cfg.Cmd || []).join(' ') || '--')}</span>
            <span class="dk-k">workingdir</span><span class="dk-v">${esc(cfg.WorkingDir || '--')}</span>
            <span class="dk-k">user</span><span class="dk-v">${esc(cfg.User || '--')}</span>
            <span class="dk-k">expose</span><span class="dk-v">${Object.keys(cfg.ExposedPorts || {}).map((p) => `<span class="dk-pill">${esc(p)}</span>`).join('') || '--'}</span>
          </div></div>
        <div class="dk-section"><div class="dk-section-title">&gt;_ environment</div>
          ${env.length ? env.map(([k, v]) => `<div class="dk-kv"><span class="dk-k">${esc(k)}</span><span class="dk-v">${esc(v)}</span></div>`).join('') : '<span class="text-dim">--</span>'}</div>`;
    } catch (err) {
      document.getElementById('dk-detail-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Volumes view
  // ════════════════════════════════════════════════════════════════════
  const VolumesView = (() => {
    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ volumes</span>
            <span><button class="btn-console btn-sm btn-warn" id="dk-v-prune">prune</button>
                  <button class="btn-console btn-sm" id="dk-v-refresh">refresh</button></span>
          </div>
          <div class="panel-body scroll-x" id="dk-v-list"><span class="text-dim">loading...</span></div>
        </div>`;
      container.querySelector('#dk-v-refresh').addEventListener('click', load);
      container.querySelector('#dk-v-prune').addEventListener('click', prune);
      load();
    }
    async function load() {
      try {
        const data = await Api.get(`${API}/volumes`);
        renderList(data?.Volumes || []);
      } catch (err) { document.getElementById('dk-v-list').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    function renderList(vols) {
      const el = document.getElementById('dk-v-list');
      if (!vols.length) { el.innerHTML = '<span class="text-dim">no volumes</span>'; return; }
      const header = '<tr><th>name</th><th>driver</th><th>mountpoint</th><th>size</th><th>created</th><th>actions</th></tr>';
      const rows = vols.map((v) => {
        const ref = refEncode(v.Name);
        return `<tr>
          <td>${esc(v.Name)}</td><td class="text-dim">${esc(v.Driver)}</td>
          <td class="text-muted">${esc(v.Mountpoint)}</td>
          <td>${v.UsageData?.Size != null ? fmtB(v.UsageData.Size) : '--'} <span class="text-muted">(${v.UsageData?.RefCount ?? 0} ref)</span></td>
          <td class="text-dim">${fmtDate(v.CreatedAt)}</td>
          <td><div class="dk-actions">
            <button class="btn-console btn-sm dk-act" data-ref="${esc(ref)}" data-action="inspect">info</button>
            <button class="btn-console btn-sm btn-err dk-act" data-ref="${esc(ref)}" data-name="${esc(v.Name)}" data-action="remove">rm</button>
          </div></td></tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      el.querySelectorAll('.dk-act').forEach((b) => b.addEventListener('click', () => handle(b)));
    }
    function handle(btn) {
      const ref = decodeURIComponent(btn.dataset.ref);
      if (btn.dataset.action === 'inspect') { openVolumeDetail(ref); return; }
      if (btn.dataset.action === 'remove') {
        if (!armConfirm(`vol:${ref}`, btn, '[y/N]?')) return;
        setBtnPending(btn, 'removing…');
        Api.delete(`${API}/volumes/${refEncode(ref)}`).then(() => { App.toast(`removed ${ref}`, 'ok'); clearConfirm(`vol:${ref}`); load(); })
          .catch((e) => { clearBtnPending(btn); App.toast(`rm: ${e.message}`, 'error'); clearConfirm(`vol:${ref}`); });
      }
    }
    async function openVolumeDetail(name) {
      closeDetail();
      detailState = { id: name, name, statsTimer: null, isVolume: true };
      document.getElementById('dk-detail-title').textContent = `>_ volume: ${name}`;
      document.getElementById('dk-detail-actions').innerHTML = '';
      document.getElementById('dk-detail-body').innerHTML = '<span class="text-dim">loading...</span>';
      document.getElementById('dk-detail-overlay').classList.remove('hidden');
      try {
        const v = await Api.get(`${API}/volumes/${refEncode(name)}`);
        document.getElementById('dk-detail-body').innerHTML = `
          <div class="dk-section"><div class="dk-section-title">&gt;_ overview</div>
            <div class="dk-kv">
              <span class="dk-k">name</span><span class="dk-v">${esc(v.Name)}</span>
              <span class="dk-k">driver</span><span class="dk-v">${esc(v.Driver)}</span>
              <span class="dk-k">scope</span><span class="dk-v">${esc(v.Scope)}</span>
              <span class="dk-k">mountpoint</span><span class="dk-v">${esc(v.Mountpoint)}</span>
              <span class="dk-k">created</span><span class="dk-v">${fmtDate(v.CreatedAt)}</span>
              <span class="dk-k">size</span><span class="dk-v">${v.UsageData?.Size != null ? fmtB(v.UsageData.Size) : '--'}</span>
              <span class="dk-k">refcount</span><span class="dk-v">${esc(v.UsageData?.RefCount ?? '--')}</span>
            </div></div>`;
      } catch (err) { document.getElementById('dk-detail-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    async function prune() {
      if (!confirm('Prune unused volumes?')) return;
      const pruneBtn = document.getElementById('dk-v-prune');
      setBtnPending(pruneBtn, 'pruning…');
      try { const r = await Api.post(`${API}/volumes/prune`, {}); App.toast(`pruned volumes${r?.SpaceReclaimed ? ' (' + fmtB(r.SpaceReclaimed) + ')' : ''}`, 'ok'); load(); }
      catch (e) { App.toast(`prune: ${e.message}`, 'error'); }
      finally { clearBtnPending(pruneBtn); }
    }
    function destroy() {}
    function refresh() { load(); }
    return { render, destroy, refresh };
  })();

  // ════════════════════════════════════════════════════════════════════
  //  Networks view
  // ════════════════════════════════════════════════════════════════════
  const NetworksView = (() => {
    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ networks</span>
            <span><button class="btn-console btn-sm btn-warn" id="dk-n-prune">prune</button>
                  <button class="btn-console btn-sm" id="dk-n-refresh">refresh</button></span>
          </div>
          <div class="panel-body scroll-x" id="dk-n-list"><span class="text-dim">loading...</span></div>
        </div>`;
      container.querySelector('#dk-n-refresh').addEventListener('click', load);
      container.querySelector('#dk-n-prune').addEventListener('click', prune);
      load();
    }
    async function load() {
      try { renderList(await Api.get(`${API}/networks`)); }
      catch (err) { document.getElementById('dk-n-list').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    function renderList(nets) {
      const el = document.getElementById('dk-n-list');
      if (!nets.length) { el.innerHTML = '<span class="text-dim">no networks</span>'; return; }
      const header = '<tr><th>name</th><th>id</th><th>driver</th><th>scope</th><th>containers</th><th>actions</th></tr>';
      const rows = nets.map((n) => {
        const ref = refEncode(n.Name);
        const cont = Object.keys(n.Containers || {}).length;
        return `<tr>
          <td>${esc(n.Name)}</td><td class="text-muted">${esc(shortId(n.Id))}</td>
          <td class="text-dim">${esc(n.Driver)}</td><td class="text-dim">${esc(n.Scope)}</td>
          <td>${cont}</td>
          <td><div class="dk-actions">
            <button class="btn-console btn-sm dk-act" data-ref="${esc(ref)}" data-action="inspect">info</button>
            <button class="btn-console btn-sm btn-err dk-act" data-ref="${esc(ref)}" data-name="${esc(n.Name)}" data-action="remove">rm</button>
          </div></td></tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      el.querySelectorAll('.dk-act').forEach((b) => b.addEventListener('click', () => handle(b)));
    }
    function handle(btn) {
      const ref = decodeURIComponent(btn.dataset.ref);
      if (btn.dataset.action === 'inspect') { openNetDetail(ref); return; }
      if (btn.dataset.action === 'remove') {
        if (!armConfirm(`net:${ref}`, btn, '[y/N]?')) return;
        setBtnPending(btn, 'removing…');
        Api.delete(`${API}/networks/${refEncode(ref)}`).then(() => { App.toast(`removed ${ref}`, 'ok'); clearConfirm(`net:${ref}`); load(); })
          .catch((e) => { clearBtnPending(btn); App.toast(`rm: ${e.message}`, 'error'); clearConfirm(`net:${ref}`); });
      }
    }
    async function openNetDetail(name) {
      closeDetail();
      detailState = { id: name, name, statsTimer: null, isNet: true };
      document.getElementById('dk-detail-title').textContent = `>_ network: ${name}`;
      document.getElementById('dk-detail-actions').innerHTML = '';
      document.getElementById('dk-detail-body').innerHTML = '<span class="text-dim">loading...</span>';
      document.getElementById('dk-detail-overlay').classList.remove('hidden');
      try {
        const n = await Api.get(`${API}/networks/${refEncode(name)}`);
        const cont = Object.entries(n.Containers || {}).map(([k, v]) => `<div class="dk-kv"><span class="dk-k">${esc((v.Name || k).slice(0, 18))}</span><span class="dk-v">${esc(v.IPv4Address || '--')}</span></div>`).join('') || '<span class="text-dim">--</span>';
        document.getElementById('dk-detail-body').innerHTML = `
          <div class="dk-section"><div class="dk-section-title">&gt;_ overview</div>
            <div class="dk-kv">
              <span class="dk-k">name</span><span class="dk-v">${esc(n.Name)}</span>
              <span class="dk-k">id</span><span class="dk-v">${esc(shortId(n.Id))}</span>
              <span class="dk-k">driver</span><span class="dk-v">${esc(n.Driver)}</span>
              <span class="dk-k">scope</span><span class="dk-v">${esc(n.Scope)}</span>
              <span class="dk-k">internal</span><span class="dk-v">${n.Internal ? 'yes' : 'no'}</span>
              <span class="dk-k">subnet</span><span class="dk-v">${esc(n.IPAM?.Config?.map((c) => c.Subnet).join(', ') || '--')}</span>
            </div></div>
          <div class="dk-section"><div class="dk-section-title">&gt;_ containers</div>${cont}</div>`;
      } catch (err) { document.getElementById('dk-detail-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    async function prune() {
      if (!confirm('Prune unused networks?')) return;
      const pruneBtn = document.getElementById('dk-n-prune');
      setBtnPending(pruneBtn, 'pruning…');
      try { const r = await Api.post(`${API}/networks/prune`, {}); App.toast(`pruned networks${r?.NetworksDeleted?.length ? ' (' + r.NetworksDeleted.length + ')' : ''}`, 'ok'); load(); }
      catch (e) { App.toast(`prune: ${e.message}`, 'error'); }
      finally { clearBtnPending(pruneBtn); }
    }
    function destroy() {}
    function refresh() { load(); }
    return { render, destroy, refresh };
  })();

  // ════════════════════════════════════════════════════════════════════
  //  System view
  // ════════════════════════════════════════════════════════════════════
  const SystemView = (() => {
    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ daemon</span>
            <button class="btn-console btn-sm" id="dk-s-refresh">refresh</button>
          </div>
          <div class="panel-body" id="dk-s-info"><span class="text-dim">loading...</span></div>
        </div>
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ disk usage</span>
            <span>
              <button class="btn-console btn-sm btn-warn dk-s-prune" data-kind="images">prune unused img</button>
              <button class="btn-console btn-sm btn-warn dk-s-prune" data-kind="containers">prune ctr</button>
              <button class="btn-console btn-sm btn-warn dk-s-prune" data-kind="volumes">prune vol</button>
              <button class="btn-console btn-sm btn-warn dk-s-prune" data-kind="networks">prune net</button>
            </span>
          </div>
          <div class="panel-body" id="dk-s-df"><span class="text-dim">loading...</span></div>
        </div>`;
      container.querySelector('#dk-s-refresh').addEventListener('click', load);
      container.querySelectorAll('.dk-s-prune').forEach((b) => b.addEventListener('click', () => prune(b.dataset.kind)));
      load();
    }
    async function load() {
      loadInfo(); loadDf();
    }
    async function loadInfo() {
      try {
        const i = await Api.get(`${API}/system/info`);
        document.getElementById('dk-s-info').innerHTML = `
          <div class="dk-kv">
            <span class="dk-k">version</span><span class="dk-v">${esc(i.ServerVersion)} (api ${esc(i.ApiVersion)})</span>
            <span class="dk-k">os</span><span class="dk-v">${esc(i.OperatingSystem)} / ${esc(i.KernelVersion)}</span>
            <span class="dk-k">arch</span><span class="dk-v">${esc(i.Architecture)} · ${esc(i.NCPU)} cpu · ${fmtB(i.MemTotal)}</span>
            <span class="dk-k">storage</span><span class="dk-v">${esc(i.Driver)}</span>
            <span class="dk-k">containers</span><span class="dk-v"><span class="text-ok">${i.ContainersRunning} run</span> · <span class="text-warn">${i.ContainersPaused} paused</span> · <span class="text-err">${i.ContainersStopped} stopped</span> (${i.Containers} total)</span>
            <span class="dk-k">images</span><span class="dk-v">${i.Images}</span>
          </div>`;
      } catch (err) { document.getElementById('dk-s-info').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    async function loadDf() {
      try {
        const df = await Api.get(`${API}/system/df`);
        const row = (label, total, active, size, reclaimable) =>
          `<tr><td>${esc(label)}</td><td>${total}</td><td>${active}</td><td>${fmtB(size)}</td><td class="text-warn">${fmtB(reclaimable)}</td></tr>`;
        const img = df.Images || [];
        const ctr = df.Containers || [];
        const vol = df.Volumes || [];
        // Per-row reclaimable matches what the corresponding prune button
        // actually frees (docker <type> prune semantics):
        //   images     = unreferenced (Containers === 0) image Size
        //   containers = stopped/exited/created SizeRw (running/paused kept)
        //   volumes    = unmounted (RefCount === 0) UsageData.Size
        const unusedImg = img.filter((x) => !x.Containers);
        const stoppedCtr = ctr.filter((x) => x.State !== 'running');
        const unmountedVol = vol.filter((x) => (x.UsageData?.RefCount || 0) === 0);
        const imgReclaim = unusedImg.reduce((a, x) => a + (x.Size || 0), 0);
        const ctrReclaim = stoppedCtr.reduce((a, x) => a + (x.SizeRw || 0), 0);
        const volReclaim = unmountedVol.reduce((a, x) => a + (x.UsageData?.Size || 0), 0);
        const rows = [
          row('images', img.length, img.length - unusedImg.length, df.LayersSize || img.reduce((a, x) => a + (x.Size || 0), 0), imgReclaim),
          row('containers', ctr.length, ctr.length - stoppedCtr.length, ctr.reduce((a, x) => a + (x.SizeRootFs || 0), 0), ctrReclaim),
          row('volumes', vol.length, vol.length - unmountedVol.length, vol.reduce((a, x) => a + (x.UsageData?.Size || 0), 0), volReclaim),
        ];
        document.getElementById('dk-s-df').innerHTML = `<table class="table-console"><tr><th>type</th><th>total</th><th>active</th><th>size</th><th>reclaimable</th></tr>${rows.join('')}</table>`;
      } catch (err) { document.getElementById('dk-s-df').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`; }
    }
    async function prune(kind) {
      const confirmMsg = kind === 'images'
        ? 'Prune all unused images (not just dangling)? This cannot be undone.'
        : `Prune ${kind}? This cannot be undone.`;
      if (!confirm(confirmMsg)) return;
      const buttons = Array.from(document.querySelectorAll('.dk-s-prune'));
      const originals = buttons.map((b) => b.textContent);
      buttons.forEach((b) => { b.disabled = true; b.textContent = 'pruning…'; });
      try {
        let r;
        const body = kind === 'images' ? { dangling: false } : {};
        if (kind === 'images') r = await Api.post(`${API}/images/prune`, body);
        else if (kind === 'containers') r = await Api.post(`${API}/containers/prune`, body);
        else if (kind === 'volumes') r = await Api.post(`${API}/volumes/prune`, body);
        else r = await Api.post(`${API}/networks/prune`, body);
        const bytes = Number(r?.SpaceReclaimed) || 0;
        const note = bytes === 0 ? ' (nothing reclaimable)' : '';
        App.toast(`pruned ${kind} — freed ${fmtB(bytes)}${note}`, 'ok');
        load();
      } catch (e) {
        App.toast(`prune: ${e.message}`, 'error');
      } finally {
        buttons.forEach((b, i) => { b.disabled = false; b.textContent = originals[i]; });
      }
    }
    function destroy() {}
    function refresh() { load(); }
    return { render, destroy, refresh };
  })();

  return { render, destroy };
})();
