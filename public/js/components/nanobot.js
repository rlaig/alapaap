'use strict';

/* ── Nanobot tabbed component: instances + cron jobs + openrouter logs ── */

const NanobotComponent = (() => {
  let currentTab = 'instances';

  /* ── Logs sub-component (adapted from nanobot-clickhouse-logs) ── */
  const LogsTab = (() => {
    const API = '/api/nanobot/logs';
    const TIME_RANGES = ['1h', '6h', '24h', '7d', '30d', 'all'];
    const PAGE_SIZES = [25, 50, 100];

    const LARGE_COL_RE = /body|payload|response|request|message|content|prompt|completion|raw/i;

    let schema = null;
    let tsCol = null;
    let state = {
      timeRange: '24h',
      search: '',
      limit: 50,
      offset: 0,
      orderDir: 'desc',
      filters: {},
      visibleCols: [],
    };
    let logData = null;
    let statsData = null;
    let detailRow = null;
    let autoRefreshTimer = null;
    let searchTimer = null;

    function render(container) {
      container.innerHTML = `
        <div id="ncl-stats" class="grid grid-4 mb-16">
          <div class="panel"><div class="panel-header">&gt;_ traces</div><div class="panel-body-pre" id="ncl-stat-traces"><span class="text-dim">--</span></div></div>
          <div class="panel"><div class="panel-header">&gt;_ tokens</div><div class="panel-body-pre" id="ncl-stat-tokens"><span class="text-dim">--</span></div></div>
          <div class="panel"><div class="panel-header">&gt;_ cost</div><div class="panel-body-pre" id="ncl-stat-cost"><span class="text-dim">--</span></div></div>
          <div class="panel"><div class="panel-header">&gt;_ errors</div><div class="panel-body-pre" id="ncl-stat-errors"><span class="text-dim">--</span></div></div>
        </div>
        <div class="panel">
          <div class="panel-header flex justify-between items-center flex-wrap gap-8">
            <span>&gt;_ log viewer</span>
            <div class="flex gap-8 items-center flex-wrap">
              <div id="ncl-time-btns" class="flex gap-8"></div>
              <input type="text" class="form-input ncl-search-input" id="ncl-search" placeholder="search..." autocomplete="off">
              <select class="form-input ncl-page-sel" id="ncl-page-size"></select>
              <button type="button" class="btn-console btn-sm" id="ncl-auto-refresh">auto: off</button>
              <button type="button" class="btn-console btn-sm" id="ncl-refresh">refresh</button>
            </div>
          </div>
          <div id="ncl-filter-chips" class="ncl-chips"></div>
          <div class="panel-body" style="padding:0">
            <div id="ncl-table-wrap" class="scroll-x">
              <span class="text-dim loading-placeholder">loading...</span>
            </div>
            <div class="flex justify-between items-center" style="padding:8px 12px;border-top:1px solid var(--border)">
              <span class="text-dim" id="ncl-page-info">--</span>
              <div class="flex gap-8">
                <button type="button" class="btn-console btn-sm" id="ncl-prev" disabled>&lt; prev</button>
                <button type="button" class="btn-console btn-sm" id="ncl-next" disabled>next &gt;</button>
              </div>
            </div>
          </div>
        </div>
        <div id="ncl-detail-overlay" class="ncl-overlay hidden">
          <div class="ncl-drawer" id="ncl-drawer">
            <div class="flex justify-between items-center" style="padding:10px 12px;border-bottom:1px solid var(--border)">
              <span class="text-dim">&gt;_ log detail</span>
              <button type="button" class="btn-icon" id="ncl-detail-close">&times;</button>
            </div>
            <div id="ncl-detail-body" class="panel-body" style="overflow-y:auto;flex:1"></div>
          </div>
        </div>`;

      buildTimeButtons();
      buildPageSizeSelect();
      bindEvents();
      loadSchema();
    }

    function buildTimeButtons() {
      const wrap = document.getElementById('ncl-time-btns');
      if (!wrap) return;
      wrap.innerHTML = TIME_RANGES.map((r) =>
        `<button type="button" class="btn-console btn-sm ncl-time-btn" data-range="${r}">${r}</button>`
      ).join('');
      syncTimeButtons();
    }

    function syncTimeButtons() {
      document.querySelectorAll('.ncl-time-btn').forEach((btn) => {
        const active = btn.dataset.range === state.timeRange;
        btn.classList.toggle('btn-ok', active);
      });
    }

    function buildPageSizeSelect() {
      const sel = document.getElementById('ncl-page-size');
      if (!sel) return;
      sel.innerHTML = PAGE_SIZES.map((n) =>
        `<option value="${n}"${n === state.limit ? ' selected' : ''}>${n}</option>`
      ).join('');
    }

    function bindEvents() {
      document.getElementById('ncl-time-btns')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.ncl-time-btn');
        if (!btn) return;
        state.timeRange = btn.dataset.range;
        state.offset = 0;
        syncTimeButtons();
        refresh();
      });

      document.getElementById('ncl-search')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.search = e.target.value;
          state.offset = 0;
          refresh();
        }, 300);
      });

      document.getElementById('ncl-page-size')?.addEventListener('change', (e) => {
        state.limit = parseInt(e.target.value, 10) || 50;
        state.offset = 0;
        loadLogs();
      });

      document.getElementById('ncl-auto-refresh')?.addEventListener('click', toggleAutoRefresh);
      document.getElementById('ncl-refresh')?.addEventListener('click', refresh);
      document.getElementById('ncl-prev')?.addEventListener('click', prevPage);
      document.getElementById('ncl-next')?.addEventListener('click', nextPage);
      document.getElementById('ncl-detail-close')?.addEventListener('click', closeDetail);
      document.getElementById('ncl-detail-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'ncl-detail-overlay') closeDetail();
      });
    }

    async function loadSchema() {
      try {
        const res = await Api.get(`${API}/schema`);
        schema = res.columns || [];
        tsCol = res.timestampColumn;

        state.visibleCols = schema
          .filter((c) => !LARGE_COL_RE.test(c.name))
          .map((c) => c.name);

        refresh();
      } catch (err) {
        document.getElementById('ncl-table-wrap').innerHTML =
          `<span class="text-err loading-placeholder">Failed to load schema: ${esc(err.message)}</span>`;
      }
    }

    function refresh() {
      loadStats();
      loadLogs();
    }

    async function loadStats() {
      try {
        const params = new URLSearchParams();
        params.set('timeRange', state.timeRange);
        if (state.search) params.set('search', state.search);
        for (const [k, v] of Object.entries(state.filters)) {
          if (v) params.set(`filter[${k}]`, v);
        }
        statsData = await Api.get(`${API}/stats?${params}`);
        renderStats();
      } catch {
        statsData = null;
        renderStats();
      }
    }

    function renderStats() {
      const s = statsData || {};
      setHtml('ncl-stat-traces', s.totalTraces != null
        ? `<span class="text-ok">${fmtNum(s.totalTraces)}</span>`
        : '<span class="text-dim">--</span>');

      if (s.hasTokenData) {
        const tokens = [];
        tokens.push(`total : ${fmtNum(s.totalTokens)}`);
        if (s.promptTokens) tokens.push(`prompt: ${fmtNum(s.promptTokens)}`);
        if (s.completionTokens) tokens.push(`compl : ${fmtNum(s.completionTokens)}`);
        setHtml('ncl-stat-tokens', tokens.join('\n'));
      } else {
        setHtml('ncl-stat-tokens', '<span class="text-dim">n/a</span>');
      }

      if (s.hasCostData) {
        setHtml('ncl-stat-cost', `<span class="text-warn">$${Number(s.totalCost).toFixed(4)}</span>`);
      } else {
        setHtml('ncl-stat-cost', '<span class="text-dim">n/a</span>');
      }

      if (s.hasErrorData) {
        const errParts = [];
        errParts.push(`count: ${fmtNum(s.errorCount)}`);
        errParts.push(`rate : ${s.errorRate}%`);
        const errColor = s.errorRate > 5 ? 'text-err' : (s.errorRate > 1 ? 'text-warn' : 'text-ok');
        setHtml('ncl-stat-errors', `<span class="${errColor}">${errParts.join('\n')}</span>`);
      } else {
        setHtml('ncl-stat-errors', '<span class="text-dim">n/a</span>');
      }
    }

    async function loadLogs() {
      const wrap = document.getElementById('ncl-table-wrap');
      if (!wrap) return;
      wrap.innerHTML = '<span class="text-dim loading-placeholder">loading...</span>';

      try {
        const params = new URLSearchParams();
        params.set('limit', state.limit);
        params.set('offset', state.offset);
        params.set('timeRange', state.timeRange);
        params.set('orderDir', state.orderDir);
        if (state.search) params.set('search', state.search);
        for (const [k, v] of Object.entries(state.filters)) {
          if (v) params.set(`filter[${k}]`, v);
        }

        logData = await Api.get(`${API}/logs?${params}`);
        renderTable();
        renderPagination();
      } catch (err) {
        logData = null;
        wrap.innerHTML = `<span class="text-err loading-placeholder">ERR: ${esc(err.message)}</span>`;
      }
    }

    function renderTable() {
      const wrap = document.getElementById('ncl-table-wrap');
      if (!wrap || !logData) return;

      const rows = logData.data || [];
      if (rows.length === 0) {
        wrap.innerHTML = '<span class="text-dim loading-placeholder">no logs found</span>';
        return;
      }

      const cols = state.visibleCols.length > 0
        ? state.visibleCols
        : (logData.meta || []).map((m) => m.name);

      if (cols.length === 0) {
        wrap.innerHTML = '<span class="text-dim loading-placeholder">no columns</span>';
        return;
      }

      const header = '<tr>' + cols.map((c) => {
        const isTs = c === tsCol;
        const arrow = isTs ? (state.orderDir === 'desc' ? ' &#9660;' : ' &#9650;') : '';
        return `<th class="${isTs ? 'ncl-sortable' : ''}" data-col="${esc(c)}">${esc(c)}${arrow}</th>`;
      }).join('') + '</tr>';

      const body = rows.map((row, idx) => {
        return `<tr class="ncl-log-row" data-idx="${idx}">` + cols.map((c) => {
          const val = row[c];
          const display = formatCell(val, c);
          const colDef = schema?.find((s) => s.name === c);
          const filterable = colDef && colDef.isString && !LARGE_COL_RE.test(c) && val != null && val !== '';
          const filterBtn = filterable
            ? ` <button type="button" class="ncl-filter-btn" data-col="${esc(c)}" data-val="${escAttr(String(val))}" title="filter by this value">&#9655;</button>`
            : '';
          return `<td title="${escAttr(String(val ?? ''))}">${display}${filterBtn}</td>`;
        }).join('') + '</tr>';
      }).join('');

      wrap.innerHTML = `<table class="table-console">${header}${body}</table>`;

      wrap.querySelectorAll('.ncl-sortable').forEach((th) => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
          state.orderDir = state.orderDir === 'desc' ? 'asc' : 'desc';
          state.offset = 0;
          loadLogs();
        });
      });

      wrap.querySelectorAll('.ncl-log-row').forEach((tr) => {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', (e) => {
          if (e.target.closest('.ncl-filter-btn')) return;
          const idx = parseInt(tr.dataset.idx, 10);
          const row = (logData.data || [])[idx];
          if (row) openDetail(row);
        });
      });

      wrap.querySelectorAll('.ncl-filter-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const col = btn.dataset.col;
          const val = btn.dataset.val;
          if (col && val) addFilter(col, val);
        });
      });
    }

    function formatCell(val, colName) {
      if (val == null || val === '') return '<span class="text-muted">--</span>';
      const str = String(val);
      if (str.length > 80) return esc(str.slice(0, 77)) + '<span class="text-muted">...</span>';
      return esc(str);
    }

    function renderPagination() {
      const total = logData?.total ?? 0;
      const pageStart = state.offset + 1;
      const pageEnd = Math.min(state.offset + state.limit, total);
      const infoEl = document.getElementById('ncl-page-info');
      if (infoEl) {
        infoEl.textContent = total > 0
          ? `${fmtNum(pageStart)}-${fmtNum(pageEnd)} of ${fmtNum(total)}`
          : 'no results';
      }

      const prevBtn = document.getElementById('ncl-prev');
      const nextBtn = document.getElementById('ncl-next');
      if (prevBtn) prevBtn.disabled = state.offset === 0;
      if (nextBtn) nextBtn.disabled = state.offset + state.limit >= total;
    }

    function prevPage() {
      state.offset = Math.max(0, state.offset - state.limit);
      loadLogs();
    }

    function nextPage() {
      state.offset += state.limit;
      loadLogs();
    }

    function addFilter(col, val) {
      state.filters[col] = val;
      state.offset = 0;
      renderFilterChips();
      refresh();
    }

    function removeFilter(col) {
      delete state.filters[col];
      state.offset = 0;
      renderFilterChips();
      refresh();
    }

    function renderFilterChips() {
      const wrap = document.getElementById('ncl-filter-chips');
      if (!wrap) return;
      const entries = Object.entries(state.filters).filter(([, v]) => v);
      if (entries.length === 0) {
        wrap.innerHTML = '';
        wrap.classList.add('hidden');
        return;
      }
      wrap.classList.remove('hidden');
      wrap.innerHTML = entries.map(([col, val]) =>
        `<span class="ncl-chip">${esc(col)}=${esc(String(val).slice(0, 30))} <button type="button" class="ncl-chip-x" data-col="${esc(col)}">&times;</button></span>`
      ).join('');
      wrap.querySelectorAll('.ncl-chip-x').forEach((btn) => {
        btn.addEventListener('click', () => removeFilter(btn.dataset.col));
      });
    }

    function openDetail(row) {
      detailRow = row;
      const overlay = document.getElementById('ncl-detail-overlay');
      const body = document.getElementById('ncl-detail-body');
      if (!overlay || !body) return;

      const allCols = schema || [];
      const lines = allCols.map((col) => {
        const val = row[col.name];
        return `<div class="ncl-detail-row">
          <div class="ncl-detail-label">${esc(col.name)} <span class="text-muted">(${esc(col.type)})</span></div>
          <div class="ncl-detail-value">${formatDetailValue(val)}</div>
        </div>`;
      }).join('');

      body.innerHTML = lines || '<span class="text-dim">no data</span>';
      overlay.classList.remove('hidden');
    }

    function formatDetailValue(val) {
      if (val == null || val === '') return '<span class="text-muted">NULL</span>';
      const str = String(val);
      if (str.length > 200 || str.includes('{') || str.includes('[')) {
        let formatted = str;
        try {
          const parsed = JSON.parse(str);
          formatted = JSON.stringify(parsed, null, 2);
        } catch { /* not json */ }
        return `<pre class="ncl-pre-value">${esc(formatted)}</pre>`;
      }
      return esc(str);
    }

    function closeDetail() {
      detailRow = null;
      document.getElementById('ncl-detail-overlay')?.classList.add('hidden');
    }

    function toggleAutoRefresh() {
      const btn = document.getElementById('ncl-auto-refresh');
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
        if (btn) { btn.textContent = 'auto: off'; btn.classList.remove('btn-ok'); }
      } else {
        autoRefreshTimer = setInterval(refresh, 10000);
        if (btn) { btn.textContent = 'auto: on'; btn.classList.add('btn-ok'); }
      }
    }

    function setHtml(id, html) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function escAttr(s) {
      return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function enc(s) { return encodeURIComponent(s); }

    function fmtNum(n) {
      return Number(n).toLocaleString();
    }

    function destroy() {
      if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      schema = null;
      logData = null;
      statsData = null;
      detailRow = null;
      state = { timeRange: '24h', search: '', limit: 50, offset: 0, orderDir: 'desc', filters: {}, visibleCols: [] };
    }

    return { render, destroy };
  })();

  /* ── Instances sub-component (adapted from nanobot-service) ── */
  const InstancesTab = (() => {
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
          <div class="panel-body scroll-x" id="ns-list">
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
          <div class="panel-body scroll-x" id="ns-configs-body">
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
        const data = await Api.get('/api/nanobot/service/instances');
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
        const data = await Api.get(`/api/nanobot/service/instances/${pid}/detail`);
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
        const data = await Api.get(`/api/nanobot/service/instances/${pid}/logs?lines=${lines}`);
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
        const configs = await Api.get('/api/nanobot/service/configs');
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

  /* ── Cron jobs sub-component (adapted from nanobot-cron) ── */
  const CronTab = (() => {
    let editingId = null;
    let editingIsSystem = false;
    let storePath = '';
    let cronSyncLock = false;
    let currentSource = null;
    let sourceList = [];

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    function sourceParam() {
      if (!currentSource) return '';
      return `?source=${encodeURIComponent(currentSource)}`;
    }

    function fmtMs(ms) {
      if (ms == null) return '--';
      try {
        return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
      } catch {
        return String(ms);
      }
    }

    function scheduleSummary(s) {
      if (!s) return '--';
      if (s.kind === 'cron') {
        const tz = s.tz ? ` (${s.tz})` : '';
        const desc = describeCron(s.expr);
        if (desc) return `${esc(desc)}${esc(tz)}`;
        return esc(`cron: ${s.expr || ''}${tz}`);
      }
      if (s.kind === 'every') {
        const ms = s.everyMs;
        if (ms >= 3600000 && ms % 3600000 === 0) return esc(`every ${ms / 3600000}h`);
        if (ms >= 60000 && ms % 60000 === 0) return esc(`every ${ms / 60000}m`);
        if (ms >= 1000 && ms % 1000 === 0) return esc(`every ${ms / 1000}s`);
        return esc(`every ${ms}ms`);
      }
      if (s.kind === 'at') return `at ${esc(fmtMs(s.atMs))}`;
      return esc(s.kind || '--');
    }

    function msToDatetimeLocal(ms) {
      if (ms == null || !Number.isFinite(ms)) return '';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function datetimeLocalToMs(s) {
      if (!s) return null;
      const t = new Date(s).getTime();
      return Number.isFinite(t) ? t : null;
    }

    /* ── Cron presets ── */
    const CRON_PRESETS = [
      { label: 'every min',    expr: '* * * * *' },
      { label: 'every 5m',     expr: '*/5 * * * *' },
      { label: 'every 15m',    expr: '*/15 * * * *' },
      { label: 'every 30m',    expr: '*/30 * * * *' },
      { label: 'hourly',       expr: '0 * * * *' },
      { label: 'every 2h',     expr: '0 */2 * * *' },
      { label: 'every 6h',     expr: '0 */6 * * *' },
      { label: 'daily 00:00',  expr: '0 0 * * *' },
      { label: 'daily 09:00',  expr: '0 9 * * *' },
      { label: 'weekly Mon',   expr: '0 9 * * 1' },
      { label: 'monthly 1st',  expr: '0 0 1 * *' },
    ];

    function describeCron(expr) {
      if (!expr || typeof expr !== 'string') return '';
      const parts = expr.trim().split(/\s+/);
      if (parts.length !== 5) return '';
      const [min, hr, dom, mon, dow] = parts;
      const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const monNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      try {
        if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'every minute';
        if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${min.slice(2)} minutes`;
        if (/^\d+$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') return `hourly at :${min.padStart(2, '0')}`;
        if (/^\d+$/.test(min) && hr.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `every ${hr.slice(2)} hours at :${min.padStart(2, '0')}`;
        if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '*') return `daily at ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
        if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && mon === '*' && /^\d$/.test(dow)) {
          return `every ${dowNames[+dow] || dow} at ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
        if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
          return `monthly on day ${dom} at ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
        if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') {
          return `yearly on ${monNames[+mon] || mon} ${dom} at ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
        }
      } catch { /* fall through */ }
      return '';
    }

    function parseCronToBuilder(expr) {
      const parts = (expr || '').trim().split(/\s+/);
      if (parts.length !== 5) return null;
      return { min: parts[0], hr: parts[1], dom: parts[2], mon: parts[3], dow: parts[4] };
    }

    function builderToCron() {
      const $ = (id) => document.getElementById(id);
      const minMode = $('nc-cb-min-mode').value;
      const hrMode = $('nc-cb-hr-mode').value;
      const domMode = $('nc-cb-dom-mode').value;
      const monMode = $('nc-cb-mon-mode').value;
      const dowMode = $('nc-cb-dow-mode').value;

      const minVal = minMode === '*' ? '*' : minMode === 'step' ? `*/${$('nc-cb-min-step').value || '5'}` : ($('nc-cb-min-at').value || '0');
      const hrVal = hrMode === '*' ? '*' : hrMode === 'step' ? `*/${$('nc-cb-hr-step').value || '2'}` : ($('nc-cb-hr-at').value || '0');
      const domVal = domMode === '*' ? '*' : ($('nc-cb-dom-at').value || '1');
      const monVal = monMode === '*' ? '*' : ($('nc-cb-mon-at').value || '1');
      const dowVal = dowMode === '*' ? '*' : ($('nc-cb-dow-at').value || '0');

      return `${minVal} ${hrVal} ${domVal} ${monVal} ${dowVal}`;
    }

    function syncBuilderFromExpr(expr) {
      const b = parseCronToBuilder(expr);
      if (!b) return;
      const $ = (id) => document.getElementById(id);
      const setField = (modeEl, stepEl, atEl, val) => {
        if (val === '*') {
          modeEl.value = '*';
        } else if (val.startsWith('*/')) {
          modeEl.value = 'step';
          if (stepEl) stepEl.value = val.slice(2);
        } else {
          modeEl.value = 'at';
          if (atEl) atEl.value = val;
        }
      };
      setField($('nc-cb-min-mode'), $('nc-cb-min-step'), $('nc-cb-min-at'), b.min);
      setField($('nc-cb-hr-mode'), $('nc-cb-hr-step'), $('nc-cb-hr-at'), b.hr);
      setField($('nc-cb-dom-mode'), null, $('nc-cb-dom-at'), b.dom);
      setField($('nc-cb-mon-mode'), null, $('nc-cb-mon-at'), b.mon);
      setField($('nc-cb-dow-mode'), null, $('nc-cb-dow-at'), b.dow);
      syncBuilderFieldVisibility();
    }

    function syncBuilderFieldVisibility() {
      const $ = (id) => document.getElementById(id);
      const toggle = (modeId, stepId, atId) => {
        const mode = $(modeId).value;
        if (stepId) $(stepId).closest('.nc-cb-sub').classList.toggle('hidden', mode !== 'step');
        if (atId) $(atId).closest('.nc-cb-sub').classList.toggle('hidden', mode !== 'at');
      };
      toggle('nc-cb-min-mode', 'nc-cb-min-step', 'nc-cb-min-at');
      toggle('nc-cb-hr-mode', 'nc-cb-hr-step', 'nc-cb-hr-at');
      toggle('nc-cb-dom-mode', null, 'nc-cb-dom-at');
      toggle('nc-cb-mon-mode', null, 'nc-cb-mon-at');
      toggle('nc-cb-dow-mode', null, 'nc-cb-dow-at');
    }

    function onBuilderChange() {
      if (cronSyncLock) return;
      cronSyncLock = true;
      syncBuilderFieldVisibility();
      const expr = builderToCron();
      document.getElementById('nc-f-expr').value = expr;
      highlightMatchingPreset(expr);
      updateCronPreview(expr);
      cronSyncLock = false;
    }

    function onRawExprInput() {
      if (cronSyncLock) return;
      cronSyncLock = true;
      const expr = document.getElementById('nc-f-expr').value.trim();
      syncBuilderFromExpr(expr);
      highlightMatchingPreset(expr);
      updateCronPreview(expr);
      cronSyncLock = false;
    }

    function onPresetClick(expr) {
      cronSyncLock = true;
      document.getElementById('nc-f-expr').value = expr;
      syncBuilderFromExpr(expr);
      highlightMatchingPreset(expr);
      updateCronPreview(expr);
      cronSyncLock = false;
    }

    function highlightMatchingPreset(expr) {
      const normed = (expr || '').trim();
      document.querySelectorAll('.nc-preset-btn').forEach((btn) => {
        btn.classList.toggle('nc-preset-active', btn.dataset.expr === normed);
      });
    }

    function updateCronPreview(expr) {
      const el = document.getElementById('nc-cron-preview');
      if (!el) return;
      const desc = describeCron(expr);
      el.textContent = desc ? `→ ${desc}` : '';
    }

    function buildSelectOptions(start, end, labels) {
      let html = '';
      for (let i = start; i <= end; i++) {
        const label = labels ? (labels[i] || i) : String(i).padStart(2, '0');
        html += `<option value="${i}">${label}</option>`;
      }
      return html;
    }

    function cronBuilderHTML() {
      const dowLabels = { 0:'Sun', 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat' };
      const monLabels = { 1:'Jan', 2:'Feb', 3:'Mar', 4:'Apr', 5:'May', 6:'Jun', 7:'Jul', 8:'Aug', 9:'Sep', 10:'Oct', 11:'Nov', 12:'Dec' };

      const presetBtns = CRON_PRESETS.map((p) =>
        `<button type="button" class="btn-console btn-sm nc-preset-btn" data-expr="${esc(p.expr)}">${esc(p.label)}</button>`
      ).join('');

      return `
        <div class="nc-cron-presets mb-8" style="display:flex;flex-wrap:wrap;gap:4px">
          ${presetBtns}
        </div>
        <div class="nc-cb-grid mb-8">
          <div class="nc-cb-row">
            <span class="nc-cb-label">min</span>
            <select class="form-input nc-cb-sel nc-cb-mode" id="nc-cb-min-mode">
              <option value="*">every</option>
              <option value="step">every Nth</option>
              <option value="at">at</option>
            </select>
            <span class="nc-cb-sub hidden"><input type="number" class="form-input nc-cb-num" id="nc-cb-min-step" min="1" max="59" value="5"></span>
            <span class="nc-cb-sub hidden"><select class="form-input nc-cb-sel" id="nc-cb-min-at">${buildSelectOptions(0, 59)}</select></span>
          </div>
          <div class="nc-cb-row">
            <span class="nc-cb-label">hour</span>
            <select class="form-input nc-cb-sel nc-cb-mode" id="nc-cb-hr-mode">
              <option value="*">every</option>
              <option value="step">every Nth</option>
              <option value="at">at</option>
            </select>
            <span class="nc-cb-sub hidden"><input type="number" class="form-input nc-cb-num" id="nc-cb-hr-step" min="1" max="23" value="2"></span>
            <span class="nc-cb-sub hidden"><select class="form-input nc-cb-sel" id="nc-cb-hr-at">${buildSelectOptions(0, 23)}</select></span>
          </div>
          <div class="nc-cb-row">
            <span class="nc-cb-label">day</span>
            <select class="form-input nc-cb-sel nc-cb-mode" id="nc-cb-dom-mode">
              <option value="*">every</option>
              <option value="at">on</option>
            </select>
            <span class="nc-cb-sub hidden"><select class="form-input nc-cb-sel" id="nc-cb-dom-at">${buildSelectOptions(1, 31)}</select></span>
          </div>
          <div class="nc-cb-row">
            <span class="nc-cb-label">month</span>
            <select class="form-input nc-cb-sel nc-cb-mode" id="nc-cb-mon-mode">
              <option value="*">every</option>
              <option value="at">on</option>
            </select>
            <span class="nc-cb-sub hidden"><select class="form-input nc-cb-sel" id="nc-cb-mon-at">${buildSelectOptions(1, 12, monLabels)}</select></span>
          </div>
          <div class="nc-cb-row">
            <span class="nc-cb-label">weekday</span>
            <select class="form-input nc-cb-sel nc-cb-mode" id="nc-cb-dow-mode">
              <option value="*">every</option>
              <option value="at">on</option>
            </select>
            <span class="nc-cb-sub hidden"><select class="form-input nc-cb-sel" id="nc-cb-dow-at">${buildSelectOptions(0, 6, dowLabels)}</select></span>
          </div>
        </div>
        <div id="nc-cron-preview" class="text-ok mb-8" style="font-size:11px;min-height:16px"></div>`;
    }

    function initCronBuilder() {
      document.querySelectorAll('.nc-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => onPresetClick(btn.dataset.expr));
      });
      document.querySelectorAll('.nc-cb-mode, .nc-cb-sel, .nc-cb-num').forEach((el) => {
        el.addEventListener('change', onBuilderChange);
        el.addEventListener('input', onBuilderChange);
      });
      document.getElementById('nc-f-expr').addEventListener('input', onRawExprInput);
    }

    function renderSourceTabs() {
      const container = document.getElementById('nc-source-tabs');
      if (!container) return;
      if (sourceList.length <= 1) {
        const label = sourceList.length === 1 ? esc(sourceList[0].label) : '';
        container.innerHTML = label ? `<span class="text-dim">[${label}]</span>` : '';
        return;
      }
      container.innerHTML = sourceList.map((s) => {
        const active = s.key === currentSource ? ' nc-source-active' : '';
        return `<button type="button" class="btn-console btn-sm nc-source-tab${active}" data-source="${esc(s.key)}">${esc(s.label)}</button>`;
      }).join(' ');
      container.querySelectorAll('.nc-source-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.source === currentSource) return;
          currentSource = btn.dataset.source;
          loadAll();
        });
      });
    }

    function render(container) {
      container.innerHTML = `
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ nanobot cron</span>
            <div>
              <span id="nc-source-tabs" style="display:inline-flex;gap:4px;margin-right:8px"></span>
              <button type="button" class="btn-console btn-sm" id="nc-refresh">refresh</button>
              <button type="button" class="btn-console btn-sm btn-ok" id="nc-add">add job</button>
            </div>
          </div>
          <div class="panel-body">
            <p class="text-dim mb-8" id="nc-status">loading...</p>
            <div id="nc-table-wrap" class="scroll-x"></div>
          </div>
        </div>
        <div class="panel mt-16 hidden" id="nc-modal-panel">
          <div class="panel-header flex justify-between items-center">
            <span id="nc-modal-title">&gt;_ edit job</span>
            <button type="button" class="btn-console btn-sm" id="nc-modal-close">close</button>
          </div>
          <div class="panel-body" style="max-width:560px">
            <form id="nc-form">
              <input type="hidden" id="nc-f-id" value="">
              <div class="form-group">
                <label class="form-label">&gt;_ name</label>
                <input type="text" class="form-input" id="nc-f-name" required>
              </div>
              <div class="form-group">
                <label class="form-label"><input type="checkbox" id="nc-f-enabled" checked> enabled</label>
              </div>
              <div class="form-group">
                <label class="form-label">&gt;_ schedule kind</label>
                <select class="form-input" id="nc-f-kind">
                  <option value="cron">cron</option>
                  <option value="every">every (interval)</option>
                  <option value="at">at (one shot)</option>
                </select>
              </div>
              <div class="form-group" id="nc-gr-cron">
                ${cronBuilderHTML()}
                <label class="form-label">&gt;_ cron expression</label>
                <input type="text" class="form-input" id="nc-f-expr" placeholder="0 9 * * *">
                <label class="form-label mt-8">&gt;_ timezone (optional, default UTC)</label>
                <input type="text" class="form-input" id="nc-f-tz" placeholder="America/Vancouver">
              </div>
              <div class="form-group hidden" id="nc-gr-every">
                <label class="form-label">&gt;_ interval (seconds)</label>
                <input type="number" class="form-input" id="nc-f-every-sec" min="1" step="1" value="3600">
              </div>
              <div class="form-group hidden" id="nc-gr-at">
                <label class="form-label">&gt;_ run at (local)</label>
                <input type="datetime-local" class="form-input" id="nc-f-at">
              </div>
              <div class="form-group">
                <label class="form-label">&gt;_ message</label>
                <textarea class="form-input" id="nc-f-message" rows="3"></textarea>
              </div>
              <div class="form-group">
                <label class="form-label"><input type="checkbox" id="nc-f-deliver"> deliver</label>
              </div>
              <div class="form-group">
                <label class="form-label">&gt;_ channel</label>
                <input type="text" class="form-input" id="nc-f-channel" placeholder="optional">
              </div>
              <div class="form-group">
                <label class="form-label">&gt;_ to</label>
                <input type="text" class="form-input" id="nc-f-to" placeholder="optional">
              </div>
              <div class="form-group">
                <label class="form-label"><input type="checkbox" id="nc-f-delete-after"> delete after run (at only)</label>
              </div>
              <div class="form-error" id="nc-form-err"></div>
              <button type="submit" class="btn-console btn-ok">[SAVE]</button>
            </form>
          </div>
        </div>`;

      document.getElementById('nc-refresh').addEventListener('click', loadAll);
      document.getElementById('nc-add').addEventListener('click', () => openModal(null));
      document.getElementById('nc-modal-close').addEventListener('click', closeModal);
      document.getElementById('nc-f-kind').addEventListener('change', syncKindFields);
      document.getElementById('nc-form').addEventListener('submit', handleSubmit);
      initCronBuilder();

      loadAll();
    }

    function syncKindFields() {
      const k = document.getElementById('nc-f-kind').value;
      document.getElementById('nc-gr-cron').classList.toggle('hidden', k !== 'cron');
      document.getElementById('nc-gr-every').classList.toggle('hidden', k !== 'every');
      document.getElementById('nc-gr-at').classList.toggle('hidden', k !== 'at');
    }

    async function loadAll() {
      const statusEl = document.getElementById('nc-status');
      const wrap = document.getElementById('nc-table-wrap');
      try {
        const srcData = await Api.get('/api/nanobot/cron/sources');
        sourceList = srcData.sources || [];
        if (sourceList.length === 0) {
          currentSource = null;
          renderSourceTabs();
          statusEl.innerHTML = 'Not configured. Set <code>ALAPAAP_NANOBOT_CRON_SOURCES</code> or <code>ALAPAAP_NANOBOT_CRON_SCAN_DIRS</code>, then restart.';
          wrap.innerHTML = '';
          return;
        }
        if (!currentSource || !sourceList.find((s) => s.key === currentSource)) {
          currentSource = sourceList[0].key;
        }
        renderSourceTabs();

        const st = await Api.get(`/api/nanobot/cron/status${sourceParam()}`);
        if (!st.configured) {
          statusEl.innerHTML = `Source <b>${esc(currentSource)}</b>: not configured.`;
          wrap.innerHTML = '';
          return;
        }
        storePath = st.path || '';
        const errCount = st.parseErrorCount || 0;
        const errBadge = errCount > 0 ? ` — <span class="text-err">${errCount} skipped (parse error)</span>` : '';
        statusEl.innerHTML = `File: <span class="text-dim">${esc(storePath)}</span> — ${st.jobCount ?? 0} job(s)${errBadge}`;

        const data = await Api.get(`/api/nanobot/cron/store${sourceParam()}`);
        const jobs = data.jobs || [];
        const parseErrors = data.parseErrors || [];
        if (jobs.length === 0 && parseErrors.length === 0) {
          wrap.innerHTML = '<span class="text-dim">no jobs</span>';
          return;
        }
        const header = '<tr><th>name</th><th>id</th><th>on</th><th>schedule</th><th>next run</th><th></th></tr>';
        const rows = jobs.map((j) => {
          const sys = j.payload && j.payload.kind === 'system_event';
          const sysBadge = sys ? ' <span class="text-dim">[sys]</span>' : '';
          return `<tr>
            <td>${esc(j.name)}${sysBadge}</td>
            <td class="text-dim">${esc(j.id)}</td>
            <td><input type="checkbox" class="nc-toggle" data-id="${esc(j.id)}" ${j.enabled ? 'checked' : ''} ${sys ? '' : ''}></td>
            <td class="text-dim">${scheduleSummary(j.schedule)}</td>
            <td class="text-dim">${fmtMs(j.state && j.state.nextRunAtMs)}</td>
            <td>
              <button type="button" class="btn-console btn-sm nc-edit" data-id="${esc(j.id)}">edit</button>
              ${sys ? '' : `<button type="button" class="btn-console btn-sm btn-err nc-del" data-id="${esc(j.id)}">del</button>`}
            </td>
          </tr>`;
        }).join('');
        const errorRows = parseErrors.map((e) =>
          `<tr class="text-err">
            <td>${esc(e.name || '--')}</td>
            <td class="text-dim">${esc(e.id)}</td>
            <td colspan="3">parse error: ${esc(e.error)}</td>
            <td></td>
          </tr>`
        ).join('');
        wrap.innerHTML = `<table class="table-console">${header}${rows}${errorRows}</table>`;
        wrap.querySelectorAll('.nc-toggle').forEach((cb) => {
          cb.addEventListener('change', (e) => toggleEnabled(e.target.dataset.id, e.target.checked));
        });
        wrap.querySelectorAll('.nc-edit').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const job = jobs.find((x) => x.id === id);
            if (job) openModal(job);
          });
        });
        wrap.querySelectorAll('.nc-del').forEach((btn) => {
          btn.addEventListener('click', () => deleteJob(btn.dataset.id));
        });
      } catch (err) {
        statusEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
        wrap.innerHTML = '';
      }
    }

    async function toggleEnabled(id, enabled) {
      try {
        await Api.patch(`/api/nanobot/cron/jobs/${encodeURIComponent(id)}${sourceParam()}`, { enabled });
        App.toast(enabled ? 'enabled' : 'disabled', 'ok');
        await loadAll();
      } catch (err) {
        App.toast(err.message, 'error');
        await loadAll();
      }
    }

    async function deleteJob(id) {
      if (!confirm(`Delete job ${id}?`)) return;
      try {
        await Api.delete(`/api/nanobot/cron/jobs/${encodeURIComponent(id)}${sourceParam()}`);
        App.toast('deleted', 'ok');
        await loadAll();
      } catch (err) {
        App.toast(err.message, 'error');
      }
    }

    function closeModal() {
      document.getElementById('nc-modal-panel').classList.add('hidden');
      editingId = null;
      editingIsSystem = false;
    }

    function openModal(job) {
      editingId = job ? job.id : null;
      editingIsSystem = Boolean(job && job.payload && job.payload.kind === 'system_event');
      document.getElementById('nc-modal-title').textContent = job ? '>_ edit job' : '>_ add job';
      document.getElementById('nc-form-err').textContent = '';
      document.getElementById('nc-f-id').value = job ? job.id : '';
      document.getElementById('nc-f-name').value = job ? job.name : '';
      document.getElementById('nc-f-enabled').checked = job ? job.enabled !== false : true;
      const kind = job && job.schedule ? job.schedule.kind : 'cron';
      document.getElementById('nc-f-kind').value = kind;
      const cronExpr = job && job.schedule && job.schedule.expr ? job.schedule.expr : '0 9 * * *';
      document.getElementById('nc-f-expr').value = cronExpr;
      document.getElementById('nc-f-tz').value = job && job.schedule && job.schedule.tz ? job.schedule.tz : '';
      syncBuilderFromExpr(cronExpr);
      highlightMatchingPreset(cronExpr);
      updateCronPreview(cronExpr);
      const everySec = job && job.schedule && job.schedule.everyMs
        ? Math.max(1, Math.round(job.schedule.everyMs / 1000))
        : 3600;
      document.getElementById('nc-f-every-sec').value = String(everySec);
      document.getElementById('nc-f-at').value = job && job.schedule && job.schedule.atMs
        ? msToDatetimeLocal(job.schedule.atMs)
        : '';
      document.getElementById('nc-f-message').value = job && job.payload ? job.payload.message || '' : '';
      document.getElementById('nc-f-deliver').checked = Boolean(job && job.payload && job.payload.deliver);
      document.getElementById('nc-f-channel').value = job && job.payload && job.payload.channel ? job.payload.channel : '';
      document.getElementById('nc-f-to').value = job && job.payload && job.payload.to ? job.payload.to : '';
      document.getElementById('nc-f-delete-after').checked = Boolean(job && job.deleteAfterRun);
      syncKindFields();
      document.getElementById('nc-modal-panel').classList.remove('hidden');
    }

    function buildScheduleFromForm() {
      const kind = document.getElementById('nc-f-kind').value;
      if (kind === 'cron') {
        const expr = document.getElementById('nc-f-expr').value.trim();
        const tzRaw = document.getElementById('nc-f-tz').value.trim();
        return { kind: 'cron', expr, tz: tzRaw || null };
      }
      if (kind === 'every') {
        const sec = parseInt(document.getElementById('nc-f-every-sec').value, 10);
        if (!Number.isFinite(sec) || sec < 1) throw new Error('interval must be at least 1 second');
        return { kind: 'every', everyMs: sec * 1000 };
      }
      const atMs = datetimeLocalToMs(document.getElementById('nc-f-at').value);
      if (atMs == null) throw new Error('pick a date/time for at schedule');
      return { kind: 'at', atMs };
    }

    function buildPayloadFromForm() {
      const channel = document.getElementById('nc-f-channel').value.trim();
      const to = document.getElementById('nc-f-to').value.trim();
      return {
        message: document.getElementById('nc-f-message').value,
        deliver: document.getElementById('nc-f-deliver').checked,
        channel: channel || null,
        to: to || null,
      };
    }

    async function handleSubmit(e) {
      e.preventDefault();
      const errEl = document.getElementById('nc-form-err');
      errEl.textContent = '';
      try {
        const schedule = buildScheduleFromForm();
        const payload = buildPayloadFromForm();
        const name = document.getElementById('nc-f-name').value.trim();
        if (!name) throw new Error('name required');
        const enabled = document.getElementById('nc-f-enabled').checked;
        const deleteAfterRun = document.getElementById('nc-f-delete-after').checked;

        if (editingId) {
          const body = { name, enabled, schedule, payload, deleteAfterRun };
          if (editingIsSystem) body.payload = { ...payload, kind: 'system_event' };
          await Api.patch(`/api/nanobot/cron/jobs/${encodeURIComponent(editingId)}${sourceParam()}`, body);
          App.toast('saved', 'ok');
        } else {
          await Api.post(`/api/nanobot/cron/jobs${sourceParam()}`, {
            name,
            enabled,
            schedule,
            payload,
            deleteAfterRun,
          });
          App.toast('created', 'ok');
        }
        closeModal();
        await loadAll();
      } catch (err) {
        errEl.textContent = `ERR: ${err.message}`;
      }
    }

    function destroy() {}

    return { render, destroy };
  })();

  /* ── Main tabbed shell ── */

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('#nb-tabs .bt-tab').forEach((t) => {
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab);
    });
    const content = document.getElementById('nb-tab-content');
    if (!content) return;

    // Destroy current sub-component before switching
    if (tab === 'instances') {
      CronTab.destroy();
      LogsTab.destroy();
      InstancesTab.render(content);
    } else if (tab === 'cron') {
      InstancesTab.destroy();
      LogsTab.destroy();
      CronTab.render(content);
    } else if (tab === 'logs') {
      InstancesTab.destroy();
      CronTab.destroy();
      LogsTab.render(content);
    }
  }

  function render(container) {
    container.innerHTML = `
      <div class="bt-tabs" id="nb-tabs">
        <button class="bt-tab bt-tab-active" data-tab="instances">&gt;_ instances</button>
        <button class="bt-tab" data-tab="cron">&gt;_ cron jobs</button>
        <button class="bt-tab" data-tab="logs">&gt;_ openrouter logs</button>
      </div>
      <div id="nb-tab-content"></div>`;

    document.getElementById('nb-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });

    switchTab('instances');
  }

  function destroy() {
    InstancesTab.destroy();
    CronTab.destroy();
    LogsTab.destroy();
    currentTab = 'instances';
  }

  return { render, destroy };
})();
