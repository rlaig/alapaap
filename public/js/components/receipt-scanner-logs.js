'use strict';

const ReceiptScannerLogsComponent = (() => {
  const API = '/api/receipt-scanner-logs';

  let state = {
    mainTab: 'status',  // Top-level tab: status, auth
  };

  let wsHandler = null;
  let statusData = null;
  let logViewer = null;

  // Deploy state
  let deployState = {
    target: 'all',
    status: 'idle',
    lines: [],
  };
  let deployWsHandler = null;
  let deployConfirmTimer = null;
  let deployConfirmActive = false;

  // Auth DB state
  let authDbTab = 'overview';
  let adb = {
    overview: null,
    usersPage: 1, usersSearch: '', usersData: null,
    selectedUserId: null, userDetail: null,
    tokensPage: 1, tokensIncludeRevoked: false, tokensUserId: '', tokensData: null,
    usagePage: 1, usageAction: '', usageSearch: '', usageUserId: '', usageData: null,
    receiptsPage: 1, receiptsSearch: '', receiptsModel: '', receiptsUserId: '',
    receiptsStatus: '', receiptsCategory: '', receiptsData: null,
    selectedReceiptId: null, receiptDetail: null,
    paymentsPage: 1, paymentsEventType: '', paymentsStatus: '', paymentsUserId: '', paymentsData: null,
    _linkedUserLabel: null,
  };

  function render(container) {
    container.innerHTML = `
      <!-- Top-level tabs -->
      <div class="bt-tabs" id="rsl-main-tabs">
        <button type="button" class="bt-tab bt-tab-active" data-tab="status">service status</button>
        <button type="button" class="bt-tab" data-tab="auth">auth db</button>
        <button type="button" class="bt-tab" data-tab="deploy">deploy</button>
      </div>

      <!-- Tab: Service Status -->
      <div id="rsl-tab-status" class="bt-tab-content active">
        <div class="panel">
          <div class="panel-header flex justify-between items-center flex-wrap gap-8">
            <span>&gt;_ receipt scanner services</span>
            <button type="button" class="btn-console btn-sm" id="rsl-refresh-status">refresh</button>
          </div>
          <div class="panel-body">
            <table class="table-console" id="rsl-status-table">
              <tr><td colspan="5" class="text-dim">loading...</td></tr>
            </table>
            <div id="rsl-usage" class="text-dim mt-8" style="font-size:var(--t-11)"></div>
          </div>
        </div>
        <!-- Log viewer container (managed by LogViewerWidget) -->
        <div id="rsl-log-container"></div>
      </div>

      <!-- Tab: Auth DB -->
      <div id="rsl-tab-auth" class="bt-tab-content">
        <div class="panel" id="rsl-authdb-panel">
          <div class="panel-header flex justify-between items-center flex-wrap gap-8">
            <span>&gt;_ auth db</span>
            <button type="button" class="btn-console btn-sm" id="rsl-authdb-refresh">refresh</button>
          </div>
          <div class="panel-body">
            <div class="bt-tabs" id="rsl-authdb-tabs">
              <button type="button" class="bt-tab bt-tab-active" data-tab="overview">overview</button>
              <button type="button" class="bt-tab" data-tab="users">users</button>
              <button type="button" class="bt-tab" data-tab="tokens">tokens</button>
              <button type="button" class="bt-tab" data-tab="usage-logs">usage logs</button>
              <button type="button" class="bt-tab" data-tab="receipts">receipts</button>
              <button type="button" class="bt-tab" data-tab="payments">payments</button>
            </div>
            <div id="rsl-authdb-content"><span class="text-dim">loading...</span></div>
          </div>
        </div>
      </div>

      <div id="rsl-authdb-overlay" class="drawer-overlay hidden">
        <div class="drawer rsl-drawer" id="rsl-authdb-drawer">
          <div class="flex justify-between items-center" style="padding:10px 12px;border-bottom:1px solid var(--color-rule)">
            <span class="text-dim">&gt;_ user detail</span>
            <button type="button" class="btn-icon" id="rsl-authdb-close-drawer">&times;</button>
          </div>
          <div id="rsl-authdb-drawer-body" class="panel-body" style="overflow-y:auto;flex:1"></div>
        </div>
      </div>

      <!-- Tab: Deploy -->
      <div id="rsl-tab-deploy" class="bt-tab-content">
        <div class="panel">
          <div class="panel-header flex justify-between items-center flex-wrap gap-8">
            <span>&gt;_ deploy receipt scanner</span>
          </div>
          <div class="panel-body">
            <div class="flex flex-wrap gap-8 mb-8">
              <span class="text-dim" style="font-size:var(--t-11);line-height:26px">target:</span>
              <button type="button" class="btn-console btn-sm btn-ok" data-dtarget="all">all</button>
              <button type="button" class="btn-console btn-sm" data-dtarget="frontend">frontend</button>
              <button type="button" class="btn-console btn-sm" data-dtarget="backend">backend</button>
              <button type="button" class="btn-console btn-sm" data-dtarget="scan">scan</button>
              <button type="button" class="btn-console btn-sm" data-dtarget="auth">auth</button>
            </div>
            <div class="flex items-center gap-8 mb-8">
              <button type="button" class="btn-console btn-sm" id="rsl-deploy-btn">deploy</button>
              <span id="rsl-deploy-status" class="text-dim" style="font-size:var(--t-11)">idle</span>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span class="text-dim">&gt;_ deploy output</span>
            <button type="button" class="btn-console btn-sm" id="rsl-deploy-clear">clear</button>
          </div>
          <div class="panel-body-pre" id="rsl-deploy-output-wrap">
            <pre id="rsl-deploy-output" class="rsl-deploy-pre"><span class="text-dim">no deploy output yet</span></pre>
          </div>
        </div>
      </div>`;

    bindEvents();
    loadStatus();
    loadUsage();
    switchAuthDbTab('overview');

    // Initialize shared log viewer widget
    const logContainer = document.getElementById('rsl-log-container');
    if (logContainer) {
      logViewer = LogViewerWidget.create(logContainer, {
        wsChannel: 'receipt-scanner-logs:logs',
        apiEndpoint: `${API}/logs`,
        services: ['all', 'receipt-scanner.service', 'auth-service.service'],
        maxEntries: 2000,
        filters: { service: true, level: true, timeRange: true, search: true, lines: true },
        shortSvc: shortSvc,
        idPrefix: 'rsl-lv',
      });
    }
  }

  // === Receipt scanner functions ===

  function bindEvents() {
    document.getElementById('rsl-refresh-status')?.addEventListener('click', () => { loadStatus(); loadUsage(); });

    // Main tabs event listeners
    document.getElementById('rsl-main-tabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchMainTab(btn.dataset.tab);
    });

    // Auth DB events
    document.getElementById('rsl-authdb-tabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchAuthDbTab(btn.dataset.tab);
    });

    document.getElementById('rsl-authdb-refresh')?.addEventListener('click', () => switchAuthDbTab(authDbTab));
    document.getElementById('rsl-authdb-close-drawer')?.addEventListener('click', closeDrawer);
    document.getElementById('rsl-authdb-overlay')?.addEventListener('click', e => {
      if (e.target.id === 'rsl-authdb-overlay') closeDrawer();
    });

    wsHandler = data => {
      if (data?.services) {
        statusData = data.services;
        renderStatus();
      }
    };
    WsClient.subscribe('receipt-scanner-logs:status', wsHandler);

    // Deploy tab events
    document.querySelectorAll('[data-dtarget]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (deployState.status === 'running') return;
        deployState.target = btn.dataset.dtarget;
        document.querySelectorAll('[data-dtarget]').forEach(b => b.classList.toggle('btn-ok', b.dataset.dtarget === deployState.target));
        resetDeployConfirm();
      });
    });

    document.getElementById('rsl-deploy-btn')?.addEventListener('click', handleDeployClick);
    document.getElementById('rsl-deploy-clear')?.addEventListener('click', () => {
      deployState.lines = [];
      renderDeployOutput();
    });

    // Deploy tab events

    deployWsHandler = data => {
      if (data?.type === 'line') {
        deployState.lines.push(data.text);
        renderDeployOutput();
      } else if (data?.type === 'status') {
        deployState.status = data.status;
        renderDeployStatus();
        if (data.status !== 'running') {
          resetDeployConfirm();
        }
      }
    };
    WsClient.subscribe('receipt-scanner-logs:deploy', deployWsHandler);
  }

  async function loadStatus() {
    try {
      const res = await Api.get(`${API}/status`);
      statusData = res.services || [];
      renderStatus();
    } catch (err) {
      document.getElementById('rsl-status-table').innerHTML =
        `<tr><td class="text-err">ERR: ${esc(err.message)}</td></tr>`;
    }
  }

  function renderStatus() {
    const table = document.getElementById('rsl-status-table');
    if (!table || !statusData) return;

    if (statusData.length === 0) {
      table.innerHTML = '<tr><td class="text-dim">no services found</td></tr>';
      return;
    }

    table.innerHTML = statusData.map(s => {
      const active = s.ActiveState === 'active';
      const badge = active ? '<span class="text-ok">[OK]</span>' : '<span class="text-err">[FAIL]</span>';
      const stateClass = active ? 'text-ok' : 'text-err';
      const pid = s.MainPID && s.MainPID !== '0' ? s.MainPID : '--';
      const mem = formatBytes(s.MemoryCurrent);
      return `<tr>
        <td>${badge}</td>
        <td class="text-dim">${esc(shortSvc(s.service))}</td>
        <td class="${stateClass}">${esc(s.SubState)}</td>
        <td class="text-dim">pid:${esc(pid)}</td>
        <td class="text-dim">${mem}</td>
      </tr>`;
    }).join('');
  }

  async function loadUsage() {
    const el = document.getElementById('rsl-usage');
    if (!el) return;
    try {
      const stats = await Api.get(`${API}/usage`);
      if (!stats) {
        el.textContent = 'usage stats unavailable';
        return;
      }
      const scans = stats.todayByAction?.find(a => a.action === 'scan');
      const scanCount = scans ? scans.count : 0;
      const avgTime = stats.todayReceipts?.avgTime;
      const totalSpend = stats.todayReceipts?.totalSpend;
      const todayCredits = stats.todayCredits?.total;
      const parts = [`scans today: ${scanCount}`];
      if (avgTime != null) parts.push(`avg time: ${(avgTime / 1000).toFixed(1)}s`);
      if (totalSpend != null) parts.push(`spend: $${totalSpend.toFixed(2)}`);
      if (todayCredits != null) parts.push(`credits: ${todayCredits}`);
      if (stats.receiptStatusDist?.length) {
        const statusStr = stats.receiptStatusDist.map(s => `${s.status}:${s.count}`).join(', ');
        parts.push(`[${statusStr}]`);
      }
      if (stats.usageLogs?.total) parts.push(`total scans: ${stats.usageLogs.total}`);
      el.textContent = parts.join('  |  ');
    } catch {
      el.textContent = '';
    }
  }

  function shortSvc(name) {
    if (name.startsWith('receipt-scanner')) return 'scanner';
    if (name.startsWith('auth-service')) return 'auth';
    return name.replace('.service', '');
  }

  function formatBytes(str) {
    const n = parseInt(str, 10);
    if (!n || n <= 0) return '--';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'M';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + 'G';
  }

  // === Deploy functions ===

  const ANSI_RE = /\x1b\[[0-9;]*m/g;

  function renderDeployStatus() {
    const el = document.getElementById('rsl-deploy-status');
    if (!el) return;
    const btn = document.getElementById('rsl-deploy-btn');
    const s = deployState.status;
    if (s === 'idle') {
      el.className = 'text-dim';
      el.textContent = 'idle';
      if (btn) btn.disabled = false;
    } else if (s === 'running') {
      el.className = 'text-warn';
      el.textContent = `running [${deployState.target}]...`;
      if (btn) btn.disabled = true;
    } else if (s === 'done') {
      el.className = 'text-ok';
      el.textContent = `done [${deployState.target}]`;
      if (btn) btn.disabled = false;
    } else if (s === 'failed') {
      el.className = 'text-err';
      el.textContent = `failed [${deployState.target}]`;
      if (btn) btn.disabled = false;
    }
  }

  function renderDeployOutput() {
    const pre = document.getElementById('rsl-deploy-output');
    const wrap = document.getElementById('rsl-deploy-output-wrap');
    if (!pre || !wrap) return;
    if (deployState.lines.length === 0) {
      pre.innerHTML = '<span class="text-dim">no deploy output yet</span>';
      return;
    }
    pre.textContent = deployState.lines.join('\n');
    // Auto-scroll only if user is near the bottom
    const nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 60;
    if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function resetDeployConfirm() {
    deployConfirmActive = false;
    if (deployConfirmTimer) { clearTimeout(deployConfirmTimer); deployConfirmTimer = null; }
    const btn = document.getElementById('rsl-deploy-btn');
    if (btn) {
      btn.textContent = 'deploy';
      btn.classList.remove('btn-warn');
      btn.disabled = deployState.status === 'running';
    }
  }

  function handleDeployClick() {
    if (deployState.status === 'running') return;
    if (deployConfirmActive) {
      // Second click — execute
      deployConfirmActive = false;
      if (deployConfirmTimer) { clearTimeout(deployConfirmTimer); deployConfirmTimer = null; }
      executeDeploy();
      return;
    }
    // First click — arm confirmation
    deployConfirmActive = true;
    const btn = document.getElementById('rsl-deploy-btn');
    if (btn) {
      btn.textContent = `confirm [${deployState.target}]?`;
      btn.classList.add('btn-warn');
    }
    deployConfirmTimer = setTimeout(() => {
      resetDeployConfirm();
    }, 3000);
  }

  async function executeDeploy() {
    try {
      deployState.lines = [];
      deployState.status = 'running';
      renderDeployOutput();
      renderDeployStatus();
      await Api.post(`${API}/deploy`, { target: deployState.target });
      App.toast(`deploy [${deployState.target}] started`, 'ok');
    } catch (err) {
      const msg = err.error || err.message || 'deploy failed';
      if (msg.includes('already in progress')) {
        App.toast('deploy already in progress', 'warn');
      } else {
        App.toast(`deploy error: ${msg}`, 'error');
      }
      deployState.status = 'idle';
      renderDeployStatus();
    }
    resetDeployConfirm();
  }

  // === Auth DB functions ===

  function switchMainTab(tab) {
    state.mainTab = tab;
    // Update main tab buttons
    document.querySelectorAll('#rsl-main-tabs .bt-tab').forEach(t => {
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab);
    });
    // Show/hide tab content
    document.querySelectorAll('.bt-tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `rsl-tab-${tab}`);
    });
  }

  function switchAuthDbTab(tab) {
    authDbTab = tab;
    document.querySelectorAll('#rsl-authdb-tabs .bt-tab').forEach(t => {
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab);
    });
    renderAuthDbContent();
  }

  function renderAuthDbContent() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;

    switch (authDbTab) {
      case 'overview': loadAuthDbOverview(); break;
      case 'users': loadUsers(); break;
      case 'tokens': loadTokens(); break;
      case 'usage-logs': loadUsageLogs(); break;
      case 'receipts': loadReceipts(); break;
      case 'payments': loadPayments(); break;
      default: el.innerHTML = '<span class="text-dim">unknown tab</span>';
    }
  }

  // --- Overview ---

  async function loadAuthDbOverview() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      adb.overview = await Api.get(`${API}/auth-db/overview`);
      renderOverview();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderOverview() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.overview) return;
    const { tables, dbSize, path: dbPath } = adb.overview;
    const tableEntries = Object.entries(tables);

    el.innerHTML = `
      <div class="rsl-authdb-stats">
        ${tableEntries.map(([name, count]) => `
          <div class="rsl-authdb-stat-card">
            <div class="rsl-authdb-stat-value">${count}</div>
            <div class="rsl-authdb-stat-label">${esc(name)}</div>
          </div>`).join('')}
        <div class="rsl-authdb-stat-card">
          <div class="rsl-authdb-stat-value">${formatBytes(String(dbSize))}</div>
          <div class="rsl-authdb-stat-label">db size</div>
        </div>
      </div>
      <div class="text-dim" style="font-size:var(--t-12);margin-bottom:12px">${esc(dbPath)}</div>
      <div class="flex gap-8 items-center">
        <span class="text-dim">maintenance:</span>
        <button type="button" class="btn-console btn-sm btn-warn" id="rsl-authdb-vacuum-btn">[VACUUM]</button>
      </div>
      <div id="rsl-authdb-vacuum-area" class="mt-8 hidden">
        <div class="flex gap-8 items-center flex-wrap">
          <span class="text-dim">type VACUUM to confirm:</span>
          <input type="text" class="form-input" id="rsl-authdb-vacuum-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:120px">
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-authdb-vacuum-go" disabled>execute</button>
          <button type="button" class="btn-console btn-sm" id="rsl-authdb-vacuum-cancel">cancel</button>
        </div>
        <div id="rsl-authdb-vacuum-result" class="mt-8" style="font-size:var(--t-11)"></div>
      </div>`;

    document.getElementById('rsl-authdb-vacuum-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-authdb-vacuum-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-authdb-vacuum-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-authdb-vacuum-area')?.classList.add('hidden');
    });
    const vacuumInput = document.getElementById('rsl-authdb-vacuum-input');
    const vacuumGo = document.getElementById('rsl-authdb-vacuum-go');
    vacuumInput?.addEventListener('input', () => {
      vacuumGo.disabled = vacuumInput.value !== 'VACUUM';
    });
    vacuumGo?.addEventListener('click', async () => {
      try {
        const res = await Api.post(`${API}/auth-db/vacuum`, { confirm: 'VACUUM' });
        document.getElementById('rsl-authdb-vacuum-result').innerHTML = `<span class="text-ok">VACUUM complete. New size: ${formatBytes(String(res.dbSize))}</span>`;
        document.getElementById('rsl-authdb-vacuum-area').classList.add('hidden');
        loadAuthDbOverview();
      } catch (err) {
        document.getElementById('rsl-authdb-vacuum-result').innerHTML = `<span class="text-err">${esc(err.message)}</span>`;
      }
    });
  }

  // --- Users ---

  async function loadUsers() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      adb.usersData = await Api.get(`${API}/auth-db/users?page=${adb.usersPage}&search=${encodeURIComponent(adb.usersSearch)}`);
      renderUsersTable();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderUsersTable() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.usersData) return;
    const { users, total, page, pageSize } = adb.usersData;
    const totalPages = Math.ceil(total / pageSize) || 1;

    el.innerHTML = `
      <div class="flex justify-between items-center flex-wrap gap-8" style="margin-bottom:12px">
        <div class="flex gap-8 items-center">
          <input type="text" class="form-input" id="rsl-adb-user-search" placeholder="search email/name..." autocomplete="off" value="${esc(adb.usersSearch)}" style="padding:2px 8px;font-size:var(--t-12);max-width:200px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-user-search-btn">search</button>
        </div>
        <button type="button" class="btn-console btn-sm btn-ok" id="rsl-adb-create-user">+ create user</button>
      </div>
      <div id="rsl-adb-create-area" class="hidden" style="margin-bottom:12px;padding:8px 12px;border:1px solid var(--color-rule)">
        <div class="form-group"><label class="form-label">email</label><input type="email" class="form-input" id="rsl-adb-new-email" style="font-size:var(--t-11)"></div>
        <div class="form-group"><label class="form-label">name</label><input type="text" class="form-input" id="rsl-adb-new-name" style="font-size:var(--t-11)"></div>
        <div class="form-group"><label class="form-label">tier</label><select class="form-input" id="rsl-adb-new-tier" style="font-size:var(--t-11)"><option value="free">free</option><option value="pro">pro</option><option value="admin">admin</option></select></div>
        <div class="form-error" id="rsl-adb-create-error"></div>
        <div class="flex gap-8">
          <button type="button" class="btn-console btn-sm btn-ok" id="rsl-adb-create-go">create</button>
          <button type="button" class="btn-console btn-sm" id="rsl-adb-create-cancel">cancel</button>
        </div>
      </div>
      ${users.length === 0 ? '<span class="text-dim">no users found</span>' : `
      <div style="overflow-x:auto">
        <table class="table-console">
          <tr><th>email</th><th>name</th><th>tier</th><th>credits</th><th>subscription</th><th>status</th><th>last login</th><th>created</th><th>actions</th></tr>
          ${users.map(u => {
            const activeBadge = u.is_active ? '<span class="text-ok">active</span>' : '<span class="text-err">disabled</span>';
            const subStatus = u.subscription_status || (u.lifetime_tier ? '<span class="text-ok">lifetime</span>' : '--');
            const subClass = u.subscription_status === 'active' ? 'text-ok' : u.subscription_status === 'cancelled' || u.subscription_status === 'expired' ? 'text-err' : 'text-dim';
            return `<tr>
            <td>${esc(u.email || '--')}</td>
            <td>${esc(u.name || '--')}</td>
            <td><span class="${u.tier === 'pro' ? 'text-ok' : 'text-dim'}">${esc(u.tier)}</span></td>
            <td class="text-dim">${u.prepaid_credits || 0}</td>
            <td><span class="${subClass}" style="font-size:var(--t-12)">${typeof subStatus === 'string' && !subStatus.includes('<') ? esc(subStatus) : subStatus}</span></td>
            <td>${activeBadge}</td>
            <td class="text-dim" style="font-size:var(--t-12)">${esc(u.last_login_at || '--')}</td>
            <td class="text-dim" style="font-size:var(--t-12)">${esc(u.created_at || '')}</td>
            <td><button type="button" class="btn-console btn-sm" data-user-id="${esc(u.id)}">view</button></td>
          </tr>`;}).join('')}
        </table>
      </div>
      ${paginationHTML(page, totalPages, total, 'rsl-adb-user-page')}`}`;

    document.getElementById('rsl-adb-user-search-btn')?.addEventListener('click', () => {
      adb.usersSearch = document.getElementById('rsl-adb-user-search')?.value || '';
      adb.usersPage = 1;
      loadUsers();
    });
    document.getElementById('rsl-adb-user-search')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.usersSearch = e.target.value || '';
        adb.usersPage = 1;
        loadUsers();
      }
    });

    document.getElementById('rsl-adb-create-user')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-create-area')?.classList.toggle('hidden');
    });
    document.getElementById('rsl-adb-create-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-create-area')?.classList.add('hidden');
    });
    document.getElementById('rsl-adb-create-go')?.addEventListener('click', async () => {
      const errEl = document.getElementById('rsl-adb-create-error');
      errEl.textContent = '';
      const email = document.getElementById('rsl-adb-new-email')?.value;
      const name = document.getElementById('rsl-adb-new-name')?.value;
      const tier = document.getElementById('rsl-adb-new-tier')?.value;
      try {
        await Api.post(`${API}/auth-db/users`, { email, name, tier });
        document.getElementById('rsl-adb-create-area')?.classList.add('hidden');
        App.toast('user created', 'ok');
        loadUsers();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    });

    el.querySelectorAll('[data-user-id]').forEach(btn => {
      btn.addEventListener('click', () => openUserDetail(btn.dataset.userId));
    });
    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        adb.usersPage = parseInt(btn.dataset.page);
        loadUsers();
      });
    });
  }

  // --- User Detail Drawer ---

  async function openUserDetail(id) {
    adb.selectedUserId = id;
    const overlay = document.getElementById('rsl-authdb-overlay');
    const body = document.getElementById('rsl-authdb-drawer-body');
    if (!overlay || !body) return;
    overlay.classList.remove('hidden');
    body.innerHTML = '<span class="text-dim">loading...</span>';

    try {
      adb.userDetail = await Api.get(`${API}/auth-db/users/${id}`);
      renderUserDetail();
    } catch (err) {
      body.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function closeDrawer() {
    document.getElementById('rsl-authdb-overlay')?.classList.add('hidden');
    const header = document.querySelector('#rsl-authdb-drawer > div:first-child span');
    if (header) header.textContent = '>_ user detail';
    adb.selectedUserId = null;
    adb.userDetail = null;
  }

  function viewUserLinked(tab, userId, userLabel) {
    closeDrawer();
    // Set userId filter for the target tab
    if (tab === 'receipts') { adb.receiptsUserId = userId; adb.receiptsPage = 1; adb._linkedUserLabel = userLabel; }
    else if (tab === 'payments') { adb.paymentsUserId = userId; adb.paymentsPage = 1; adb._linkedUserLabel = userLabel; }
    else if (tab === 'tokens') { adb.tokensUserId = userId; adb.tokensPage = 1; adb._linkedUserLabel = userLabel; }
    else if (tab === 'usage-logs') { adb.usageUserId = userId; adb.usagePage = 1; adb._linkedUserLabel = userLabel; }
    switchAuthDbTab(tab);
  }

  function clearLinkedUserFilter(tab) {
    if (tab === 'receipts') adb.receiptsUserId = '';
    else if (tab === 'payments') adb.paymentsUserId = '';
    else if (tab === 'tokens') adb.tokensUserId = '';
    else if (tab === 'usage-logs') adb.usageUserId = '';
    adb._linkedUserLabel = null;
  }

  function linkedUserBannerHTML(tab) {
    if (!adb._linkedUserLabel && !adb[tab === 'usage-logs' ? 'usageUserId' : tab === 'receipts' ? 'receiptsUserId' : tab === 'payments' ? 'paymentsUserId' : 'tokensUserId']) return '';
    const userId = adb[tab === 'usage-logs' ? 'usageUserId' : tab === 'receipts' ? 'receiptsUserId' : tab === 'payments' ? 'paymentsUserId' : 'tokensUserId'];
    if (!userId) return '';
    const label = adb._linkedUserLabel || userId.slice(0, 8) + '...';
    return `<div class="flex items-center gap-8" style="margin-bottom:8px;padding:4px 8px;background:var(--color-panel);border:1px solid var(--color-rule);border-radius:4px;font-size:var(--t-12)">
      <span class="text-warn">filtered by user:</span> <span>${esc(label)}</span>
      <button type="button" class="btn-console btn-sm" data-clear-linked-user="1">[clear]</button>
    </div>`;
  }

  function renderUserDetail() {
    const body = document.getElementById('rsl-authdb-drawer-body');
    if (!body || !adb.userDetail) return;
    const u = adb.userDetail;

    body.innerHTML = `
      <div style="padding:12px">
        <div class="flex justify-between items-center" style="margin-bottom:16px">
          <div>
            <div style="font-size:1.1rem">${esc(u.name || 'unnamed')}</div>
            <div class="text-dim" style="font-size:var(--t-11)">${esc(u.email || 'no email')}</div>
          </div>
          <span class="${u.tier === 'pro' ? 'text-ok' : 'text-dim'}" style="font-size:var(--t-13)">${esc(u.tier)}</span>
        </div>

        <div class="rsl-authdb-stats" style="margin-bottom:16px">
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${u.socialAccounts?.length || 0}</div><div class="rsl-authdb-stat-label">linked accounts</div></div>
          <div class="rsl-authdb-stat-card" style="cursor:pointer" data-view-linked="tokens"><div class="rsl-authdb-stat-value">${u.tokenCount}</div><div class="rsl-authdb-stat-label">tokens</div></div>
          <div class="rsl-authdb-stat-card" style="cursor:pointer" data-view-linked="usage-logs"><div class="rsl-authdb-stat-value">${u.usageCount}</div><div class="rsl-authdb-stat-label">usage logs</div></div>
          <div class="rsl-authdb-stat-card" style="cursor:pointer" data-view-linked="receipts"><div class="rsl-authdb-stat-value">${u.receiptCount}</div><div class="rsl-authdb-stat-label">receipts</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${u.prepaid_credits || 0}</div><div class="rsl-authdb-stat-label">credits</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${u.login_count || 0}</div><div class="rsl-authdb-stat-label">logins</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${u.is_active ? '<span class="text-ok">on</span>' : '<span class="text-err">off</span>'}</div><div class="rsl-authdb-stat-label">active</div></div>
          <div class="rsl-authdb-stat-card" style="cursor:pointer" data-view-linked="payments"><div class="rsl-authdb-stat-value">${u.paymentEventCount || 0}</div><div class="rsl-authdb-stat-label">payments</div></div>
        </div>

        <div class="text-dim" style="font-size:var(--t-12);margin-bottom:16px">
          id: ${esc(u.id)}<br>
          created: ${esc(u.created_at)} | updated: ${esc(u.updated_at)}<br>
          last login: ${esc(u.last_login_at || '--')} | verified: ${esc(u.email_verified_at || '--')}
        </div>

        ${u.subscription_id || u.subscription_status || u.lifetime_tier ? `
        <div style="margin-bottom:16px;padding:8px 12px;border:1px solid var(--color-rule);border-radius:4px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:6px">subscription</div>
          <div style="font-size:var(--t-11)">
            <span class="${u.subscription_status === 'active' ? 'text-ok' : u.subscription_status === 'cancelled' ? 'text-err' : 'text-dim'}">${esc(u.subscription_status || 'none')}</span>
            ${u.subscription_product ? `<span class="text-dim"> · ${esc(u.subscription_product)}</span>` : ''}
            ${u.lifetime_tier ? '<span class="text-ok"> · lifetime</span>' : ''}
          </div>
          ${u.customer_id ? `<div class="text-dim" style="font-size:var(--t-12)">customer: ${esc(u.customer_id)}</div>` : ''}
          ${u.subscription_id ? `<div class="text-dim" style="font-size:var(--t-12)">sub id: ${esc(u.subscription_id)}</div>` : ''}
        </div>` : ''}

        ${u.socialAccounts?.length ? `
        <div style="margin-bottom:16px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:4px">linked accounts</div>
          <table class="table-console">
            <tr><th>provider</th><th>provider id</th><th>linked</th><th></th></tr>
            ${u.socialAccounts.map(sa => `<tr>
              <td>${esc(sa.provider)}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(sa.provider_user_id)}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(sa.created_at)}</td>
              <td><button type="button" class="btn-console btn-sm btn-warn" data-unlink-id="${esc(sa.id)}">unlink</button></td>
            </tr>`).join('')}
          </table>
        </div>` : ''}

        <div style="border-top:1px solid var(--color-rule);padding-top:12px;margin-bottom:16px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:8px">edit user</div>
          <div class="form-group"><label class="form-label">email</label><input type="email" class="form-input" id="rsl-adb-edit-email" value="${esc(u.email || '')}" style="font-size:var(--t-11)"></div>
          <div class="form-group"><label class="form-label">name</label><input type="text" class="form-input" id="rsl-adb-edit-name" value="${esc(u.name || '')}" style="font-size:var(--t-11)"></div>
          <div class="form-group"><label class="form-label">tier</label><select class="form-input" id="rsl-adb-edit-tier" style="font-size:var(--t-11)">
            <option value="free"${u.tier === 'free' ? ' selected' : ''}>free</option>
            <option value="pro"${u.tier === 'pro' ? ' selected' : ''}>pro</option>
            <option value="admin"${u.tier === 'admin' ? ' selected' : ''}>admin</option>
          </select></div>
          <div class="form-group"><label class="form-label">avatar url</label><input type="text" class="form-input" id="rsl-adb-edit-avatar" value="${esc(u.avatar_url || '')}" style="font-size:var(--t-11)"></div>
          <div class="form-group"><label class="form-label">prepaid credits</label><input type="number" class="form-input" id="rsl-adb-edit-credits" value="${u.prepaid_credits || 0}" min="0" step="1" style="font-size:var(--t-11)"></div>
          <div class="form-group"><label class="flex gap-8 items-center" style="font-size:var(--t-11)">
            <input type="checkbox" id="rsl-adb-edit-active" ${u.is_active ? 'checked' : ''}> active
          </label></div>
          <div style="border-top:1px solid var(--color-rule);padding-top:8px;margin-top:4px">
            <div class="text-dim" style="font-size:var(--t-12);margin-bottom:8px">subscription</div>
            <div class="form-group"><label class="form-label">subscription status</label><input type="text" class="form-input" id="rsl-adb-edit-sub-status" value="${esc(u.subscription_status || '')}" style="font-size:var(--t-11)" placeholder="active, cancelled, expired..."></div>
            <div class="form-group"><label class="form-label">subscription product</label><input type="text" class="form-input" id="rsl-adb-edit-sub-product" value="${esc(u.subscription_product || '')}" style="font-size:var(--t-11)" placeholder="pro-unlimited, etc."></div>
            <div class="form-group"><label class="form-label">customer id</label><input type="text" class="form-input" id="rsl-adb-edit-customer-id" value="${esc(u.customer_id || '')}" style="font-size:var(--t-11)"></div>
            <div class="form-group"><label class="flex gap-8 items-center" style="font-size:var(--t-11)">
              <input type="checkbox" id="rsl-adb-edit-lifetime" ${u.lifetime_tier ? 'checked' : ''}> lifetime tier
            </label></div>
          </div>
          <div class="form-error" id="rsl-adb-edit-error"></div>
          <button type="button" class="btn-console btn-sm btn-ok" id="rsl-adb-edit-save">[SAVE]</button>
        </div>

        <div style="border-top:1px solid var(--color-rule);padding-top:12px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:8px">danger zone</div>
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-adb-delete-user-btn">delete user</button>
          <div id="rsl-adb-delete-area" class="hidden mt-8">
            <span class="text-dim" style="font-size:var(--t-12)">type DELETE USER to confirm:</span>
            <input type="text" class="form-input" id="rsl-adb-delete-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:160px;margin-top:4px">
            <div class="flex gap-8 mt-8">
              <button type="button" class="btn-console btn-sm btn-err" id="rsl-adb-delete-go" disabled>delete</button>
              <button type="button" class="btn-console btn-sm" id="rsl-adb-delete-cancel">cancel</button>
            </div>
            <div id="rsl-adb-delete-error" class="form-error mt-8"></div>
          </div>
        </div>
      </div>`;

    // Unlink social account
    body.querySelectorAll('[data-unlink-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await Api.delete(`${API}/auth-db/social-accounts/${btn.dataset.unlinkId}`);
          App.toast('account unlinked', 'ok');
          openUserDetail(adb.selectedUserId);
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });
    });

    // Clickable stat cards -> navigate to linked data
    const userLabel = u.email || u.name || u.id.slice(0, 8) + '...';
    body.querySelectorAll('[data-view-linked]').forEach(card => {
      card.addEventListener('click', () => {
        viewUserLinked(card.dataset.viewLinked, u.id, userLabel);
      });
    });

    // Edit user
    document.getElementById('rsl-adb-edit-save')?.addEventListener('click', async () => {
      const errEl = document.getElementById('rsl-adb-edit-error');
      errEl.textContent = '';
      try {
        const email = document.getElementById('rsl-adb-edit-email')?.value;
        const name = document.getElementById('rsl-adb-edit-name')?.value;
        const tier = document.getElementById('rsl-adb-edit-tier')?.value;
        const avatar_url = document.getElementById('rsl-adb-edit-avatar')?.value || null;
        const prepaid_credits = parseInt(document.getElementById('rsl-adb-edit-credits')?.value, 10) || 0;
        const is_active = document.getElementById('rsl-adb-edit-active')?.checked ? true : false;
        const subscription_status = document.getElementById('rsl-adb-edit-sub-status')?.value || null;
        const subscription_product = document.getElementById('rsl-adb-edit-sub-product')?.value || null;
        const customer_id = document.getElementById('rsl-adb-edit-customer-id')?.value || null;
        const lifetime_tier = document.getElementById('rsl-adb-edit-lifetime')?.checked ? true : false;
        adb.userDetail = await Api.patch(`${API}/auth-db/users/${u.id}`, { email, name, tier, avatar_url, prepaid_credits, is_active, subscription_status, subscription_product, customer_id, lifetime_tier });
        App.toast('user updated', 'ok');
        renderUserDetail();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    });

    // Delete user
    document.getElementById('rsl-adb-delete-user-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-delete-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-adb-delete-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-delete-area')?.classList.add('hidden');
    });
    const deleteInput = document.getElementById('rsl-adb-delete-input');
    const deleteGo = document.getElementById('rsl-adb-delete-go');
    deleteInput?.addEventListener('input', () => {
      deleteGo.disabled = deleteInput.value !== 'DELETE USER';
    });
    deleteGo?.addEventListener('click', async () => {
      const errEl = document.getElementById('rsl-adb-delete-error');
      errEl.textContent = '';
      try {
        await Api.delete(`${API}/auth-db/users/${u.id}`, { confirm: 'DELETE USER' });
        App.toast('user deleted', 'ok');
        closeDrawer();
        loadUsers();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    });
  }

  // --- Tokens ---

  async function loadTokens() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      const params = new URLSearchParams({ page: adb.tokensPage, includeRevoked: adb.tokensIncludeRevoked ? '1' : '0' });
      if (adb.tokensUserId) params.set('userId', adb.tokensUserId);
      adb.tokensData = await Api.get(`${API}/auth-db/tokens?${params}`);
      renderTokensTable();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderTokensTable() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.tokensData) return;
    const { tokens, total, page, pageSize } = adb.tokensData;
    const totalPages = Math.ceil(total / pageSize) || 1;

    el.innerHTML = `
      ${linkedUserBannerHTML('tokens')}
      <div class="flex justify-between items-center flex-wrap gap-8" style="margin-bottom:12px">
        <div class="flex gap-8 items-center flex-wrap">
          <label class="flex gap-8 items-center text-dim" style="font-size:var(--t-11)">
            <input type="checkbox" id="rsl-adb-tokens-revoked" ${adb.tokensIncludeRevoked ? 'checked' : ''}> include revoked
          </label>
          <span class="text-dim" style="font-size:var(--t-11)">user:</span>
          <input type="text" class="form-input" id="rsl-adb-tokens-user" placeholder="user id..." autocomplete="off" value="${esc(adb.tokensUserId)}" style="padding:2px 8px;font-size:var(--t-12);max-width:180px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-tokens-filter-btn">filter</button>
        </div>
        <button type="button" class="btn-console btn-sm btn-warn" id="rsl-adb-purge-tokens-btn">purge expired + revoked</button>
      </div>
      <div id="rsl-adb-purge-tokens-area" class="hidden" style="margin-bottom:12px;padding:8px 12px;border:1px solid var(--color-rule)">
        <span class="text-dim" style="font-size:var(--t-11)">type PURGE to confirm:</span>
        <div class="flex gap-8 items-center mt-8">
          <input type="text" class="form-input" id="rsl-adb-purge-tokens-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:120px">
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-adb-purge-tokens-go" disabled>execute</button>
          <button type="button" class="btn-console btn-sm" id="rsl-adb-purge-tokens-cancel">cancel</button>
        </div>
        <div id="rsl-adb-purge-tokens-result" class="mt-8" style="font-size:var(--t-11)"></div>
      </div>
      ${tokens.length === 0 ? '<span class="text-dim">no tokens found</span>' : `
      <div style="overflow-x:auto">
        <table class="table-console">
          <tr><th>user</th><th>expires</th><th>status</th><th>created</th><th>actions</th></tr>
          ${tokens.map(t => {
            const expired = new Date(t.expires_at) < new Date();
            const status = t.revoked ? '<span class="text-err">revoked</span>' : expired ? '<span class="text-warn">expired</span>' : '<span class="text-ok">active</span>';
            return `<tr>
              <td data-user-id="${esc(t.user_id)}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;font-size:var(--t-11)">${esc(t.user_email || t.user_id?.slice(0, 8) + '...')}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(t.expires_at)}</td>
              <td>${status}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(t.created_at)}</td>
              <td>${!t.revoked ? `<button type="button" class="btn-console btn-sm btn-warn" data-revoke-id="${esc(t.id)}">revoke</button>` : '<span class="text-dim">--</span>'}</td>
            </tr>`;
          }).join('')}
        </table>
      </div>
      ${paginationHTML(page, totalPages, total, 'rsl-adb-token-page')}`}`;

    document.getElementById('rsl-adb-tokens-revoked')?.addEventListener('change', e => {
      adb.tokensIncludeRevoked = e.target.checked;
      adb.tokensPage = 1;
      loadTokens();
    });
    document.getElementById('rsl-adb-tokens-filter-btn')?.addEventListener('click', () => {
      adb.tokensUserId = document.getElementById('rsl-adb-tokens-user')?.value || '';
      adb.tokensPage = 1;
      loadTokens();
    });
    document.getElementById('rsl-adb-tokens-user')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.tokensUserId = e.target.value || '';
        adb.tokensPage = 1;
        loadTokens();
      }
    });

    document.getElementById('rsl-adb-purge-tokens-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-tokens-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-adb-purge-tokens-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-tokens-area')?.classList.add('hidden');
    });
    const purgeInput = document.getElementById('rsl-adb-purge-tokens-input');
    const purgeGo = document.getElementById('rsl-adb-purge-tokens-go');
    purgeInput?.addEventListener('input', () => {
      purgeGo.disabled = purgeInput.value !== 'PURGE';
    });
    purgeGo?.addEventListener('click', async () => {
      try {
        const res = await Api.post(`${API}/auth-db/tokens/purge`, { confirm: 'PURGE' });
        document.getElementById('rsl-adb-purge-tokens-result').innerHTML = `<span class="text-ok">purged ${res.deleted} tokens</span>`;
        document.getElementById('rsl-adb-purge-tokens-area').classList.add('hidden');
        App.toast(`purged ${res.deleted} tokens`, 'ok');
        loadTokens();
      } catch (err) {
        document.getElementById('rsl-adb-purge-tokens-result').innerHTML = `<span class="text-err">${esc(err.message)}</span>`;
      }
    });

    el.querySelectorAll('[data-revoke-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await Api.post(`${API}/auth-db/tokens/${btn.dataset.revokeId}/revoke`);
          App.toast('token revoked', 'ok');
          loadTokens();
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });
    });
    el.querySelectorAll('[data-user-id]').forEach(cell => {
      cell.addEventListener('click', () => openUserDetail(cell.dataset.userId));
    });

    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        adb.tokensPage = parseInt(btn.dataset.page);
        loadTokens();
      });
    });

    el.querySelectorAll('[data-clear-linked-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearLinkedUserFilter('tokens');
        adb.tokensPage = 1;
        loadTokens();
      });
    });
  }

  async function loadUsageLogs() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      const params = new URLSearchParams({ page: adb.usagePage });
      if (adb.usageAction) params.set('action', adb.usageAction);
      if (adb.usageSearch) params.set('search', adb.usageSearch);
      if (adb.usageUserId) params.set('userId', adb.usageUserId);
      adb.usageData = await Api.get(`${API}/auth-db/usage-logs?${params}`);
      renderUsageLogsTable();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderUsageLogsTable() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.usageData) return;
    const { logs, total, page, pageSize, actions } = adb.usageData;
    const totalPages = Math.ceil(total / pageSize) || 1;

    el.innerHTML = `
      ${linkedUserBannerHTML('usage-logs')}
      <div class="flex justify-between items-center flex-wrap gap-8" style="margin-bottom:12px">
        <div class="flex gap-8 items-center flex-wrap">
          <input type="text" class="form-input" id="rsl-adb-usage-search" placeholder="search email/ip/details..." autocomplete="off" value="${esc(adb.usageSearch)}" style="padding:2px 8px;font-size:var(--t-12);max-width:200px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-usage-search-btn">search</button>
          <span class="text-dim" style="font-size:var(--t-11)">action:</span>
          <select class="form-input" id="rsl-adb-usage-action" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all</option>
            ${(actions || []).map(a => `<option value="${esc(a)}"${a === adb.usageAction ? ' selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <span class="text-dim" style="font-size:var(--t-11)">user:</span>
          <input type="text" class="form-input" id="rsl-adb-usage-user" placeholder="user id..." autocomplete="off" value="${esc(adb.usageUserId)}" style="padding:2px 8px;font-size:var(--t-12);max-width:180px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-usage-user-filter-btn">filter</button>
        </div>
        <button type="button" class="btn-console btn-sm btn-warn" id="rsl-adb-purge-usage-btn">purge old logs</button>
      </div>
      <div id="rsl-adb-purge-usage-area" class="hidden" style="margin-bottom:12px;padding:8px 12px;border:1px solid var(--color-rule)">
        <div class="flex gap-8 items-center flex-wrap">
          <span class="text-dim" style="font-size:var(--t-11)">delete logs older than</span>
          <input type="number" class="form-input" id="rsl-adb-purge-days" value="30" min="1" style="padding:2px 8px;font-size:var(--t-12);width:80px">
          <span class="text-dim" style="font-size:var(--t-11)">days</span>
        </div>
        <div class="flex gap-8 items-center mt-8">
          <span class="text-dim" style="font-size:var(--t-11)">type PURGE to confirm:</span>
          <input type="text" class="form-input" id="rsl-adb-purge-usage-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:120px">
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-adb-purge-usage-go" disabled>execute</button>
          <button type="button" class="btn-console btn-sm" id="rsl-adb-purge-usage-cancel">cancel</button>
        </div>
        <div id="rsl-adb-purge-usage-result" class="mt-8" style="font-size:var(--t-11)"></div>
      </div>
      ${logs.length === 0 ? '<span class="text-dim">no usage logs found</span>' : `
      <div style="overflow-x:auto">
        <table class="table-console">
          <tr><th>user</th><th>device</th><th>ip</th><th>action</th><th>credits</th><th>agent</th><th>details</th><th>created</th></tr>
          ${logs.map(l => {
            const agent = l.user_agent ? (l.user_agent.length > 40 ? l.user_agent.slice(0, 40) + '...' : l.user_agent) : '--';
            const detail = l.details ? (l.details.length > 40 ? l.details.slice(0, 40) + '...' : l.details) : '--';
            const device = l.device_id ? (l.device_id.length > 20 ? l.device_id.slice(0, 20) + '...' : l.device_id) : '--';
            const userLabel = l.user_email || (l.user_id ? l.user_id.slice(0, 8) + '...' : (l.device_id ? l.device_id.slice(0, 12) + '...' : 'anonymous'));
            return `<tr>
            <td style="font-size:var(--t-11)">${esc(userLabel)}</td>
            <td class="text-dim" style="font-size:0.75rem" title="${esc(l.device_id || '')}">${esc(device)}</td>
            <td class="text-dim" style="font-size:var(--t-12)">${esc(l.ip_address)}</td>
            <td>${esc(l.action)}</td>
            <td class="text-dim">${l.credits_used != null ? l.credits_used : '--'}</td>
            <td class="text-dim" style="font-size:0.75rem" title="${esc(l.user_agent || '')}">${esc(agent)}</td>
            <td class="text-dim" style="font-size:0.75rem" title="${esc(l.details || '')}">${esc(detail)}</td>
            <td class="text-dim" style="font-size:var(--t-12)">${esc(l.created_at)}</td>
          </tr>`;}).join('')}
        </table>
      </div>
      ${paginationHTML(page, totalPages, total, 'rsl-adb-usage-page')}`}`;

    document.getElementById('rsl-adb-usage-search-btn')?.addEventListener('click', () => {
      adb.usageSearch = document.getElementById('rsl-adb-usage-search')?.value || '';
      adb.usagePage = 1;
      loadUsageLogs();
    });
    document.getElementById('rsl-adb-usage-search')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.usageSearch = e.target.value || '';
        adb.usagePage = 1;
        loadUsageLogs();
      }
    });

    document.getElementById('rsl-adb-usage-action')?.addEventListener('change', e => {
      adb.usageAction = e.target.value;
      adb.usagePage = 1;
      loadUsageLogs();
    });
    document.getElementById('rsl-adb-usage-user-filter-btn')?.addEventListener('click', () => {
      adb.usageUserId = document.getElementById('rsl-adb-usage-user')?.value || '';
      adb.usagePage = 1;
      loadUsageLogs();
    });
    document.getElementById('rsl-adb-usage-user')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.usageUserId = e.target.value || '';
        adb.usagePage = 1;
        loadUsageLogs();
      }
    });

    document.getElementById('rsl-adb-purge-usage-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-usage-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-adb-purge-usage-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-usage-area')?.classList.add('hidden');
    });
    const purgeInput = document.getElementById('rsl-adb-purge-usage-input');
    const purgeGo = document.getElementById('rsl-adb-purge-usage-go');
    purgeInput?.addEventListener('input', () => {
      purgeGo.disabled = purgeInput.value !== 'PURGE';
    });
    purgeGo?.addEventListener('click', async () => {
      try {
        const days = parseInt(document.getElementById('rsl-adb-purge-days')?.value) || 30;
        const res = await Api.post(`${API}/auth-db/usage-logs/purge`, { confirm: 'PURGE', olderThanDays: days });
        document.getElementById('rsl-adb-purge-usage-result').innerHTML = `<span class="text-ok">purged ${res.deleted} log entries</span>`;
        document.getElementById('rsl-adb-purge-usage-area').classList.add('hidden');
        App.toast(`purged ${res.deleted} log entries`, 'ok');
        loadUsageLogs();
      } catch (err) {
        document.getElementById('rsl-adb-purge-usage-result').innerHTML = `<span class="text-err">${esc(err.message)}</span>`;
      }
    });

    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        adb.usagePage = parseInt(btn.dataset.page);
        loadUsageLogs();
      });
    });

    el.querySelectorAll('[data-clear-linked-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearLinkedUserFilter('usage-logs');
        adb.usagePage = 1;
        loadUsageLogs();
      });
    });
  }

  // --- Receipts ---

  async function loadReceipts() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      const params = new URLSearchParams({ page: adb.receiptsPage });
      if (adb.receiptsSearch) params.set('search', adb.receiptsSearch);
      if (adb.receiptsModel) params.set('model', adb.receiptsModel);
      if (adb.receiptsUserId) params.set('userId', adb.receiptsUserId);
      if (adb.receiptsStatus) params.set('status', adb.receiptsStatus);
      if (adb.receiptsCategory) params.set('category', adb.receiptsCategory);
      adb.receiptsData = await Api.get(`${API}/auth-db/receipts?${params}`);
      renderReceiptsTable();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function shortModel(m) {
    if (!m) return '--';
    const parts = m.split('/');
    return parts.length > 1 ? parts.slice(-2).join('/') : m;
  }

  function renderReceiptsTable() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.receiptsData) return;
    const { receipts, total, page, pageSize, models, statuses, categories } = adb.receiptsData;
    const totalPages = Math.ceil(total / pageSize) || 1;

    el.innerHTML = `
      ${linkedUserBannerHTML('receipts')}
      <div class="flex justify-between items-center flex-wrap gap-8" style="margin-bottom:12px">
        <div class="flex gap-8 items-center flex-wrap">
          <input type="text" class="form-input" id="rsl-adb-receipts-search" placeholder="search tags/model/merchant..." autocomplete="off" value="${esc(adb.receiptsSearch)}" style="padding:2px 8px;font-size:var(--t-12);max-width:200px">
          <select class="form-input" id="rsl-adb-receipts-model" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all models</option>
            ${(models || []).map(m => `<option value="${esc(m)}"${m === adb.receiptsModel ? ' selected' : ''}>${esc(shortModel(m))}</option>`).join('')}
          </select>
          <select class="form-input" id="rsl-adb-receipts-status" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all status</option>
            ${(statuses || []).map(s => `<option value="${esc(s)}"${s === adb.receiptsStatus ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <select class="form-input" id="rsl-adb-receipts-category" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all categories</option>
            ${(categories || []).map(c => `<option value="${esc(c)}"${c === adb.receiptsCategory ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <span class="text-dim" style="font-size:var(--t-11)">user:</span>
          <input type="text" class="form-input" id="rsl-adb-receipts-user" placeholder="user id..." autocomplete="off" value="${esc(adb.receiptsUserId)}" style="padding:2px 8px;font-size:var(--t-12);max-width:180px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-receipts-search-btn">filter</button>
        </div>
      </div>
      ${receipts.length === 0 ? '<span class="text-dim">no receipts found</span>' : `
      <div style="overflow-x:auto">
        <table class="table-console">
          <tr><th>user</th><th>status</th><th>merchant</th><th>amount</th><th>model</th><th>time</th><th>category</th><th>scanned</th><th>actions</th></tr>
          ${receipts.map(r => {
            const ms = r.processing_time_ms || 0;
            const timeStr = ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
            const statusClass = r.status === 'failed' ? 'text-err' : r.status === 'pending' ? 'text-warn' : r.status === 'completed' ? 'text-ok' : 'text-dim';
            const amountStr = r.total_amount != null ? `${r.currency || ''}${r.total_amount.toFixed(2)}` : '--';
            const userClick = r.user_id ? `data-user-id="${esc(r.user_id)}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;font-size:var(--t-11)"` : 'style="font-size:var(--t-11)"';
            return `<tr>
              <td ${userClick}>${esc(r.user_name || r.user_email || r.user_id?.slice(0, 8) + '...')}</td>
              <td><span class="${statusClass}" style="font-size:var(--t-12)">${esc(r.status || '--')}</span></td>
              <td style="font-size:var(--t-11)">${esc(r.merchant_name || '--')}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(amountStr)}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(shortModel(r.model_used))}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${timeStr}</td>
              <td style="font-size:var(--t-12)">${esc(r.category || '--')}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(r.scanned_at || '')}</td>
              <td>
                <div class="flex gap-4">
                  <button type="button" class="btn-console btn-sm" data-receipt-id="${esc(r.id)}">view</button>
                  <button type="button" class="btn-console btn-sm btn-warn" data-receipt-del="${esc(r.id)}">del</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </table>
      </div>
      ${paginationHTML(page, totalPages, total, 'rsl-adb-receipt-page')}`}`;

    document.getElementById('rsl-adb-receipts-search-btn')?.addEventListener('click', () => {
      adb.receiptsSearch = document.getElementById('rsl-adb-receipts-search')?.value || '';
      adb.receiptsModel = document.getElementById('rsl-adb-receipts-model')?.value || '';
      adb.receiptsStatus = document.getElementById('rsl-adb-receipts-status')?.value || '';
      adb.receiptsCategory = document.getElementById('rsl-adb-receipts-category')?.value || '';
      adb.receiptsUserId = document.getElementById('rsl-adb-receipts-user')?.value || '';
      adb.receiptsPage = 1;
      loadReceipts();
    });
    document.getElementById('rsl-adb-receipts-search')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.receiptsSearch = e.target.value || '';
        adb.receiptsPage = 1;
        loadReceipts();
      }
    });
    document.getElementById('rsl-adb-receipts-user')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.receiptsUserId = e.target.value || '';
        adb.receiptsPage = 1;
        loadReceipts();
      }
    });
    document.getElementById('rsl-adb-receipts-model')?.addEventListener('change', e => {
      adb.receiptsModel = e.target.value;
      adb.receiptsPage = 1;
      loadReceipts();
    });
    document.getElementById('rsl-adb-receipts-status')?.addEventListener('change', e => {
      adb.receiptsStatus = e.target.value;
      adb.receiptsPage = 1;
      loadReceipts();
    });
    document.getElementById('rsl-adb-receipts-category')?.addEventListener('change', e => {
      adb.receiptsCategory = e.target.value;
      adb.receiptsPage = 1;
      loadReceipts();
    });

    el.querySelectorAll('[data-receipt-id]').forEach(btn => {
      btn.addEventListener('click', () => openReceiptDetail(btn.dataset.receiptId));
    });
    el.querySelectorAll('[data-user-id]').forEach(cell => {
      cell.addEventListener('click', () => openUserDetail(cell.dataset.userId));
    });
    el.querySelectorAll('[data-receipt-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this receipt?')) return;
        try {
          await Api.delete(`${API}/auth-db/receipts/${btn.dataset.receiptDel}`, { confirm: 'DELETE RECEIPT' });
          App.toast('receipt deleted', 'ok');
          loadReceipts();
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });
    });
    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        adb.receiptsPage = parseInt(btn.dataset.page);
        loadReceipts();
      });
    });

    el.querySelectorAll('[data-clear-linked-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearLinkedUserFilter('receipts');
        adb.receiptsPage = 1;
        loadReceipts();
      });
    });
  }

  // --- Receipt Detail Drawer ---

  async function openReceiptDetail(id) {
    adb.selectedReceiptId = id;
    const overlay = document.getElementById('rsl-authdb-overlay');
    const body = document.getElementById('rsl-authdb-drawer-body');
    const header = document.querySelector('#rsl-authdb-drawer > div:first-child span');
    if (!overlay || !body) return;
    overlay.classList.remove('hidden');
    if (header) header.textContent = '>_ receipt detail';
    body.innerHTML = '<span class="text-dim">loading...</span>';

    try {
      adb.receiptDetail = await Api.get(`${API}/auth-db/receipts/${id}`);
      renderReceiptDetail();
    } catch (err) {
      body.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function closeReceiptDrawer() {
    document.getElementById('rsl-authdb-overlay')?.classList.add('hidden');
    const header = document.querySelector('#rsl-authdb-drawer > div:first-child span');
    if (header) header.textContent = '>_ user detail';
    adb.selectedReceiptId = null;
    adb.receiptDetail = null;
  }

  function renderReceiptDetail() {
    const body = document.getElementById('rsl-authdb-drawer-body');
    if (!body || !adb.receiptDetail) return;
    const r = adb.receiptDetail;

    let parsedData = {};
    try { parsedData = JSON.parse(r.receipt_data); } catch {}

    const ms = r.processing_time_ms || 0;
    const timeStr = ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;

    body.innerHTML = `
      <div style="padding:12px">
        <div class="flex justify-between items-center" style="margin-bottom:16px">
          <div>
            <div class="text-dim" style="font-size:var(--t-11)">${esc(r.user_name || r.user_email || 'unknown')}</div>
            <div class="text-dim" style="font-size:var(--t-12)">${esc(shortModel(r.model_used))} | ${timeStr}</div>
          </div>
          <button type="button" class="btn-console btn-sm btn-warn" id="rsl-receipt-close-detail">close</button>
        </div>

        ${r.image_thumbnail ? `
        <div style="margin-bottom:16px;text-align:center">
          <img src="data:image/jpeg;base64,${r.image_thumbnail}" alt="receipt thumbnail" style="max-width:100%;max-height:300px;border-radius:4px;border:1px solid var(--color-rule)">
        </div>` : ''}

        <div class="rsl-authdb-stats" style="margin-bottom:16px">
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(r.status || '--')}</div><div class="rsl-authdb-stat-label">status</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${r.total_amount != null ? `${r.currency || ''}${r.total_amount.toFixed(2)}` : '--'}</div><div class="rsl-authdb-stat-label">amount</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${timeStr}</div><div class="rsl-authdb-stat-label">processing</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(r.scanned_at || '--')}</div><div class="rsl-authdb-stat-label">scanned</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(r.updated_at || '--')}</div><div class="rsl-authdb-stat-label">updated</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(r.source || '--')}</div><div class="rsl-authdb-stat-label">source</div></div>
          <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${r.file_size ? formatBytes(String(r.file_size)) : '--'}</div><div class="rsl-authdb-stat-label">file size</div></div>
        </div>

        ${r.error_message ? `
        <div style="margin-bottom:16px;padding:8px 12px;border:1px solid var(--color-rule);border-radius:4px">
          <div class="text-err" style="font-size:var(--t-12);margin-bottom:4px">error</div>
          <div class="text-err" style="font-size:var(--t-11)">${esc(r.error_message)}</div>
        </div>` : ''}

        <div style="border-top:1px solid var(--color-rule);padding-top:12px;margin-bottom:16px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:4px">receipt data</div>
          <pre style="font-size:var(--t-12);background:var(--color-panel);padding:8px;border-radius:4px;overflow-x:auto;max-height:40vh;overflow-y:auto;border:1px solid var(--color-rule)">${esc(JSON.stringify(parsedData, null, 2))}</pre>
        </div>

        <div style="border-top:1px solid var(--color-rule);padding-top:12px;margin-bottom:16px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:8px">edit</div>
          <div class="form-group"><label class="form-label">status</label><select class="form-input" id="rsl-receipt-edit-status" style="font-size:var(--t-11)">
            <option value="completed"${r.status === 'completed' ? ' selected' : ''}>completed</option>
            <option value="failed"${r.status === 'failed' ? ' selected' : ''}>failed</option>
            <option value="pending"${r.status === 'pending' ? ' selected' : ''}>pending</option>
            <option value="processing"${r.status === 'processing' ? ' selected' : ''}>processing</option>
          </select></div>
          <div class="form-group"><label class="form-label">merchant name</label><input type="text" class="form-input" id="rsl-receipt-edit-merchant" value="${esc(r.merchant_name || '')}" style="font-size:var(--t-11)"></div>
          <div class="flex gap-8">
            <div class="form-group"><label class="form-label">total amount</label><input type="number" class="form-input" id="rsl-receipt-edit-amount" value="${r.total_amount ?? ''}" step="0.01" style="font-size:var(--t-11);width:120px"></div>
            <div class="form-group"><label class="form-label">currency</label><input type="text" class="form-input" id="rsl-receipt-edit-currency" value="${esc(r.currency || '')}" style="font-size:var(--t-11);width:80px" maxlength="3"></div>
          </div>
          <div class="form-group"><label class="form-label">category</label><input type="text" class="form-input" id="rsl-receipt-edit-category" value="${esc(r.category || '')}" style="font-size:var(--t-11)" placeholder="grocery, restaurant, utility..."></div>
          <div class="form-group"><label class="form-label">tags</label><input type="text" class="form-input" id="rsl-receipt-edit-tags" value="${esc(r.tags || '')}" style="font-size:var(--t-11)" placeholder="comma-separated tags"></div>
          <div class="form-group"><label class="form-label">source</label><input type="text" class="form-input" id="rsl-receipt-edit-source" value="${esc(r.source || '')}" style="font-size:var(--t-11)"></div>
          <div class="form-error" id="rsl-receipt-edit-error"></div>
          <button type="button" class="btn-console btn-sm btn-ok" id="rsl-receipt-edit-save">[SAVE]</button>
        </div>

        <div style="border-top:1px solid var(--color-rule);padding-top:12px">
          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:4px">id: ${esc(r.id)}</div>
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-receipt-delete-btn">delete receipt</button>
          <div id="rsl-receipt-delete-area" class="hidden mt-8">
            <span class="text-dim" style="font-size:var(--t-12)">type DELETE RECEIPT to confirm:</span>
            <input type="text" class="form-input" id="rsl-receipt-delete-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:180px;margin-top:4px">
            <div class="flex gap-8 mt-8">
              <button type="button" class="btn-console btn-sm btn-err" id="rsl-receipt-delete-go" disabled>delete</button>
              <button type="button" class="btn-console btn-sm" id="rsl-receipt-delete-cancel">cancel</button>
            </div>
            <div id="rsl-receipt-delete-error" class="form-error mt-8"></div>
          </div>
        </div>
      </div>`;

    document.getElementById('rsl-receipt-close-detail')?.addEventListener('click', closeReceiptDrawer);

    // Save receipt fields
    document.getElementById('rsl-receipt-edit-save')?.addEventListener('click', async () => {
      const errEl = document.getElementById('rsl-receipt-edit-error');
      errEl.textContent = '';
      try {
        const status = document.getElementById('rsl-receipt-edit-status')?.value || '';
        const merchant_name = document.getElementById('rsl-receipt-edit-merchant')?.value || null;
        const total_amount = document.getElementById('rsl-receipt-edit-amount')?.value;
        const currency = document.getElementById('rsl-receipt-edit-currency')?.value || null;
        const category = document.getElementById('rsl-receipt-edit-category')?.value || null;
        const tags = document.getElementById('rsl-receipt-edit-tags')?.value || '';
        const source = document.getElementById('rsl-receipt-edit-source')?.value || null;
        const payload = { tags, status, merchant_name, category, source };
        if (total_amount !== '') payload.total_amount = parseFloat(total_amount);
        if (currency) payload.currency = currency;
        adb.receiptDetail = await Api.patch(`${API}/auth-db/receipts/${r.id}`, payload);
        App.toast('receipt updated', 'ok');
        renderReceiptDetail();
        loadReceipts();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    });

    // Delete receipt
    document.getElementById('rsl-receipt-delete-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-receipt-delete-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-receipt-delete-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-receipt-delete-area')?.classList.add('hidden');
    });
    const delInput = document.getElementById('rsl-receipt-delete-input');
    const delGo = document.getElementById('rsl-receipt-delete-go');
    delInput?.addEventListener('input', () => {
      delGo.disabled = delInput.value !== 'DELETE RECEIPT';
    });
    delGo?.addEventListener('click', async () => {
      const errEl = document.getElementById('rsl-receipt-delete-error');
      errEl.textContent = '';
      try {
        await Api.delete(`${API}/auth-db/receipts/${r.id}`, { confirm: 'DELETE RECEIPT' });
        App.toast('receipt deleted', 'ok');
        closeReceiptDrawer();
        loadReceipts();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    });
  }

  // --- Payment Events ---

  async function loadPayments() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      const params = new URLSearchParams({ page: adb.paymentsPage });
      if (adb.paymentsEventType) params.set('eventType', adb.paymentsEventType);
      if (adb.paymentsStatus) params.set('status', adb.paymentsStatus);
      if (adb.paymentsUserId) params.set('userId', adb.paymentsUserId);
      adb.paymentsData = await Api.get(`${API}/auth-db/payments?${params}`);
      renderPaymentsTable();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderPaymentsTable() {
    const el = document.getElementById('rsl-authdb-content');
    if (!el || !adb.paymentsData) return;
    const { payments, total, page, pageSize, eventTypes, statuses } = adb.paymentsData;
    const totalPages = Math.ceil(total / pageSize) || 1;

    el.innerHTML = `
      ${linkedUserBannerHTML('payments')}
      <div class="flex justify-between items-center flex-wrap gap-8" style="margin-bottom:12px">
        <div class="flex gap-8 items-center flex-wrap">
          <span class="text-dim" style="font-size:var(--t-11)">event:</span>
          <select class="form-input" id="rsl-adb-payments-event" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all</option>
            ${(eventTypes || []).map(t => `<option value="${esc(t)}"${t === adb.paymentsEventType ? ' selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
          <span class="text-dim" style="font-size:var(--t-11)">status:</span>
          <select class="form-input" id="rsl-adb-payments-status" style="padding:2px 6px;font-size:var(--t-12)">
            <option value="">all</option>
            ${(statuses || []).map(s => `<option value="${esc(s)}"${s === adb.paymentsStatus ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <span class="text-dim" style="font-size:var(--t-11)">user:</span>
          <input type="text" class="form-input" id="rsl-adb-payments-user" placeholder="user id..." autocomplete="off" value="${esc(adb.paymentsUserId)}" style="padding:2px 8px;font-size:var(--t-12);max-width:180px">
          <button type="button" class="btn-console btn-sm" id="rsl-adb-payments-filter-btn">filter</button>
        </div>
        <button type="button" class="btn-console btn-sm btn-warn" id="rsl-adb-purge-payments-btn">purge old events</button>
      </div>
      <div id="rsl-adb-purge-payments-area" class="hidden" style="margin-bottom:12px;padding:8px 12px;border:1px solid var(--color-rule)">
        <div class="flex gap-8 items-center flex-wrap">
          <span class="text-dim" style="font-size:var(--t-11)">delete events older than</span>
          <input type="number" class="form-input" id="rsl-adb-purge-payments-days" value="90" min="1" style="padding:2px 8px;font-size:var(--t-12);width:80px">
          <span class="text-dim" style="font-size:var(--t-11)">days</span>
        </div>
        <div class="flex gap-8 items-center mt-8">
          <span class="text-dim" style="font-size:var(--t-11)">type PURGE to confirm:</span>
          <input type="text" class="form-input" id="rsl-adb-purge-payments-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:120px">
          <button type="button" class="btn-console btn-sm btn-err" id="rsl-adb-purge-payments-go" disabled>execute</button>
          <button type="button" class="btn-console btn-sm" id="rsl-adb-purge-payments-cancel">cancel</button>
        </div>
        <div id="rsl-adb-purge-payments-result" class="mt-8" style="font-size:var(--t-11)"></div>
      </div>
      ${payments.length === 0 ? '<span class="text-dim">no payment events found</span>' : `
      <div style="overflow-x:auto">
        <table class="table-console">
          <tr><th>user</th><th>event type</th><th>polar id</th><th>source</th><th>status</th><th>created</th><th>actions</th></tr>
          ${payments.map(p => {
            const statusClass = p.status === 'completed' ? 'text-ok' : p.status === 'failed' ? 'text-err' : p.status === 'pending' ? 'text-warn' : 'text-dim';
            const userLabel = p.user_email || (p.user_id ? p.user_id.slice(0, 8) + '...' : '--');
            const polarId = p.polar_id ? (p.polar_id.length > 20 ? p.polar_id.slice(0, 20) + '...' : p.polar_id) : '--';
            const userClick = p.user_id ? `data-user-id="${esc(p.user_id)}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;font-size:var(--t-11)"` : 'style="font-size:var(--t-11)"';
            return `<tr>
              <td ${userClick}>${esc(userLabel)}</td>
              <td style="font-size:var(--t-11)">${esc(p.event_type)}</td>
              <td class="text-dim" style="font-size:var(--t-12)" title="${esc(p.polar_id || '')}">${esc(polarId)}</td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(p.source || '--')}</td>
              <td><span class="${statusClass}" style="font-size:var(--t-12)">${esc(p.status || '--')}</span></td>
              <td class="text-dim" style="font-size:var(--t-12)">${esc(p.created_at || '')}</td>
              <td>
                <div class="flex gap-4">
                  <button type="button" class="btn-console btn-sm" data-payment-id="${esc(p.id)}">view</button>
                  <button type="button" class="btn-console btn-sm btn-warn" data-payment-del="${esc(p.id)}">del</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </table>
      </div>
      ${paginationHTML(page, totalPages, total, 'rsl-adb-payment-page')}`}`;

    document.getElementById('rsl-adb-payments-event')?.addEventListener('change', e => {
      adb.paymentsEventType = e.target.value;
      adb.paymentsPage = 1;
      loadPayments();
    });
    document.getElementById('rsl-adb-payments-status')?.addEventListener('change', e => {
      adb.paymentsStatus = e.target.value;
      adb.paymentsPage = 1;
      loadPayments();
    });
    document.getElementById('rsl-adb-payments-filter-btn')?.addEventListener('click', () => {
      adb.paymentsUserId = document.getElementById('rsl-adb-payments-user')?.value || '';
      adb.paymentsPage = 1;
      loadPayments();
    });
    document.getElementById('rsl-adb-payments-user')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        adb.paymentsUserId = e.target.value || '';
        adb.paymentsPage = 1;
        loadPayments();
      }
    });

    // Purge
    document.getElementById('rsl-adb-purge-payments-btn')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-payments-area')?.classList.remove('hidden');
    });
    document.getElementById('rsl-adb-purge-payments-cancel')?.addEventListener('click', () => {
      document.getElementById('rsl-adb-purge-payments-area')?.classList.add('hidden');
    });
    const purgeInput = document.getElementById('rsl-adb-purge-payments-input');
    const purgeGo = document.getElementById('rsl-adb-purge-payments-go');
    purgeInput?.addEventListener('input', () => {
      purgeGo.disabled = purgeInput.value !== 'PURGE';
    });
    purgeGo?.addEventListener('click', async () => {
      try {
        const days = parseInt(document.getElementById('rsl-adb-purge-payments-days')?.value) || 90;
        const res = await Api.post(`${API}/auth-db/payments/purge`, { confirm: 'PURGE', olderThanDays: days });
        document.getElementById('rsl-adb-purge-payments-result').innerHTML = `<span class="text-ok">purged ${res.deleted} payment events</span>`;
        document.getElementById('rsl-adb-purge-payments-area').classList.add('hidden');
        App.toast(`purged ${res.deleted} payment events`, 'ok');
        loadPayments();
      } catch (err) {
        document.getElementById('rsl-adb-purge-payments-result').innerHTML = `<span class="text-err">${esc(err.message)}</span>`;
      }
    });

    // View payment detail
    el.querySelectorAll('[data-payment-id]').forEach(btn => {
      btn.addEventListener('click', () => openPaymentDetail(btn.dataset.paymentId));
    });
    el.querySelectorAll('[data-user-id]').forEach(cell => {
      cell.addEventListener('click', () => openUserDetail(cell.dataset.userId));
    });

    // Delete payment
    el.querySelectorAll('[data-payment-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this payment event?')) return;
        try {
          await Api.delete(`${API}/auth-db/payments/${btn.dataset.paymentDel}`, { confirm: 'DELETE EVENT' });
          App.toast('payment event deleted', 'ok');
          loadPayments();
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });
    });

    el.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        adb.paymentsPage = parseInt(btn.dataset.page);
        loadPayments();
      });
    });

    el.querySelectorAll('[data-clear-linked-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearLinkedUserFilter('payments');
        adb.paymentsPage = 1;
        loadPayments();
      });
    });
  }

  async function openPaymentDetail(id) {
    const overlay = document.getElementById('rsl-authdb-overlay');
    const body = document.getElementById('rsl-authdb-drawer-body');
    const header = document.querySelector('#rsl-authdb-drawer > div:first-child span');
    if (!overlay || !body) return;
    overlay.classList.remove('hidden');
    if (header) header.textContent = '>_ payment event detail';
    body.innerHTML = '<span class="text-dim">loading...</span>';

    try {
      const p = await Api.get(`${API}/auth-db/payments/${id}`);
      let payload = {};
      try { payload = JSON.parse(p.payload_json || '{}'); } catch {}

      const statusClass = p.status === 'completed' ? 'text-ok' : p.status === 'failed' ? 'text-err' : p.status === 'pending' ? 'text-warn' : 'text-dim';

      body.innerHTML = `
        <div style="padding:12px">
          <div class="flex justify-between items-center" style="margin-bottom:16px">
            <div>
              <div style="font-size:1.1rem">${esc(p.event_type)}</div>
              <div class="text-dim" style="font-size:var(--t-11)">${esc(p.user_name || p.user_email || 'unknown user')}</div>
            </div>
            <button type="button" class="btn-console btn-sm btn-warn" id="rsl-payment-close-detail">close</button>
          </div>

          <div class="rsl-authdb-stats" style="margin-bottom:16px">
            <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value"><span class="${statusClass}">${esc(p.status || '--')}</span></div><div class="rsl-authdb-stat-label">status</div></div>
            <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(p.source || '--')}</div><div class="rsl-authdb-stat-label">source</div></div>
            <div class="rsl-authdb-stat-card"><div class="rsl-authdb-stat-value">${esc(p.created_at || '--')}</div><div class="rsl-authdb-stat-label">created</div></div>
          </div>

          <div class="text-dim" style="font-size:var(--t-12);margin-bottom:16px">
            id: ${esc(p.id)}<br>
            polar id: ${esc(p.polar_id || '--')}<br>
            user id: ${esc(p.user_id || '--')}
            ${p.outcome_details ? `<br>outcome: ${esc(p.outcome_details)}` : ''}
          </div>

          <div style="border-top:1px solid var(--color-rule);padding-top:12px">
            <div class="text-dim" style="font-size:var(--t-12);margin-bottom:4px">payload</div>
            <pre style="font-size:var(--t-12);background:var(--color-panel);padding:8px;border-radius:4px;overflow-x:auto;max-height:50vh;overflow-y:auto;border:1px solid var(--color-rule)">${esc(JSON.stringify(payload, null, 2))}</pre>
          </div>

          <div style="border-top:1px solid var(--color-rule);padding-top:12px;margin-top:16px">
            <div class="text-dim" style="font-size:var(--t-12);margin-bottom:4px">id: ${esc(p.id)}</div>
            <button type="button" class="btn-console btn-sm btn-err" id="rsl-payment-delete-btn">delete event</button>
            <div id="rsl-payment-delete-area" class="hidden mt-8">
              <span class="text-dim" style="font-size:var(--t-12)">type DELETE EVENT to confirm:</span>
              <input type="text" class="form-input" id="rsl-payment-delete-input" autocomplete="off" style="padding:2px 8px;font-size:var(--t-12);width:160px;margin-top:4px">
              <div class="flex gap-8 mt-8">
                <button type="button" class="btn-console btn-sm btn-err" id="rsl-payment-delete-go" disabled>delete</button>
                <button type="button" class="btn-console btn-sm" id="rsl-payment-delete-cancel">cancel</button>
              </div>
              <div id="rsl-payment-delete-error" class="form-error mt-8"></div>
            </div>
          </div>
        </div>`;

      document.getElementById('rsl-payment-close-detail')?.addEventListener('click', closePaymentDetail);

      document.getElementById('rsl-payment-delete-btn')?.addEventListener('click', () => {
        document.getElementById('rsl-payment-delete-area')?.classList.remove('hidden');
      });
      document.getElementById('rsl-payment-delete-cancel')?.addEventListener('click', () => {
        document.getElementById('rsl-payment-delete-area')?.classList.add('hidden');
      });
      const delInput = document.getElementById('rsl-payment-delete-input');
      const delGo = document.getElementById('rsl-payment-delete-go');
      delInput?.addEventListener('input', () => {
        delGo.disabled = delInput.value !== 'DELETE EVENT';
      });
      delGo?.addEventListener('click', async () => {
        const errEl = document.getElementById('rsl-payment-delete-error');
        errEl.textContent = '';
        try {
          await Api.delete(`${API}/auth-db/payments/${p.id}`, { confirm: 'DELETE EVENT' });
          App.toast('payment event deleted', 'ok');
          closePaymentDetail();
          loadPayments();
        } catch (err) {
          errEl.textContent = `ERR: ${err.message}`;
        }
      });
    } catch (err) {
      body.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function closePaymentDetail() {
    document.getElementById('rsl-authdb-overlay')?.classList.add('hidden');
    const header = document.querySelector('#rsl-authdb-drawer > div:first-child span');
    if (header) header.textContent = '>_ user detail';
  }

  // --- Shared helpers ---

  function paginationHTML(current, totalPages, total, pageBtnClass) {
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      if (totalPages > 7 && Math.abs(i - current) > 2 && i !== 1 && i !== totalPages) {
        if (i === 2 || i === totalPages - 1) pages.push('<span class="text-dim" style="padding:0 4px">...</span>');
        continue;
      }
      const cls = i === current ? 'btn-ok' : '';
      pages.push(`<button type="button" class="btn-console btn-sm ${cls} ${pageBtnClass}" data-page="${i}">${i}</button>`);
    }
    return `<div class="flex justify-between items-center" style="padding:8px 12px;border-top:1px solid var(--color-rule)">
      <span class="text-dim" style="font-size:var(--t-12)">page ${current} of ${totalPages} (${total} total)</span>
      <div class="flex gap-4">${pages.join('')}</div>
    </div>`;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function destroy() {
    if (logViewer) { logViewer.destroy(); logViewer = null; }
    if (wsHandler) { WsClient.unsubscribe('receipt-scanner-logs:status', wsHandler); wsHandler = null; }
    if (deployWsHandler) { WsClient.unsubscribe('receipt-scanner-logs:deploy', deployWsHandler); deployWsHandler = null; }
    if (deployConfirmTimer) { clearTimeout(deployConfirmTimer); deployConfirmTimer = null; }
    statusData = null;
    state = { mainTab: 'status' };
    authDbTab = 'overview';
    deployState = { target: 'all', status: 'idle', lines: [] };
    deployConfirmActive = false;
    adb = {
      overview: null,
      usersPage: 1, usersSearch: '', usersData: null,
      selectedUserId: null, userDetail: null,
      tokensPage: 1, tokensIncludeRevoked: false, tokensUserId: '', tokensData: null,
      usagePage: 1, usageAction: '', usageSearch: '', usageUserId: '', usageData: null,
      receiptsPage: 1, receiptsSearch: '', receiptsModel: '', receiptsUserId: '',
      receiptsStatus: '', receiptsCategory: '', receiptsData: null,
      selectedReceiptId: null, receiptDetail: null,
      paymentsPage: 1, paymentsEventType: '', paymentsStatus: '', paymentsUserId: '', paymentsData: null,
    };
  }

  return { render, destroy };
})();
