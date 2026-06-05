'use strict';

const NanobotClickhouseLogsComponent = (() => {
  const API = '/api/nanobot-clickhouse-logs';
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
          <div id="ncl-table-wrap" style="overflow-x:auto">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
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
        `<span class="text-err" style="padding:12px;display:block">Failed to load schema: ${esc(err.message)}</span>`;
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
    wrap.innerHTML = '<span class="text-dim" style="padding:12px;display:block">loading...</span>';

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
      wrap.innerHTML = `<span class="text-err" style="padding:12px;display:block">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderTable() {
    const wrap = document.getElementById('ncl-table-wrap');
    if (!wrap || !logData) return;

    const rows = logData.data || [];
    if (rows.length === 0) {
      wrap.innerHTML = '<span class="text-dim" style="padding:12px;display:block">no logs found</span>';
      return;
    }

    const cols = state.visibleCols.length > 0
      ? state.visibleCols
      : (logData.meta || []).map((m) => m.name);

    if (cols.length === 0) {
      wrap.innerHTML = '<span class="text-dim" style="padding:12px;display:block">no columns</span>';
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
