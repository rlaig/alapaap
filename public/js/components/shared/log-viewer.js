'use strict';

/**
 * Reusable log viewer widget.
 *
 * Creates a self-contained log viewer with filters, real-time streaming,
 * client-side filtering, and bounded buffer.
 *
 * Usage:
 *   const viewer = LogViewerWidget.create(container, {
 *     wsChannel:    'module:logs',
 *     apiEndpoint:  '/api/module/logs',
 *     services:     ['all', 'svc1.service', 'svc2.service'],
 *     maxEntries:   2000,
 *     filters:      { service: true, level: true, timeRange: true, search: true, lines: true },
 *     shortSvc:     (name) => name.replace('.service', ''),
 *   });
 *   // Later: viewer.destroy();
 */
const LogViewerWidget = (() => {

  const LEVELS = ['all', 'INFO', 'WARNING', 'ERROR', 'DEBUG'];
  const TIME_RANGES = ['1h', '6h', '24h', '7d', 'all'];
  const LINE_OPTIONS = [100, 200, 500];
  const MAX_ENTRIES_DEFAULT = 2000;

  // ─── Helpers ───

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function defaultShortSvc(name) {
    if (!name) return '';
    return name.replace('.service', '');
  }

  // ─── Widget implementation ───

  function create(container, opts = {}) {
    const {
      wsChannel,
      apiEndpoint,
      services = [],
      maxEntries = MAX_ENTRIES_DEFAULT,
      filters = { service: true, level: true, timeRange: true, search: true, lines: true },
      shortSvc = defaultShortSvc,
      idPrefix = 'lv',
    } = opts;

    // State
    const logEntries = [];
    let activeService = 'all';
    let activeLevel = 'all';
    let activeTimeRange = '24h';
    let activeSearch = '';
    let activeLines = 200;
    let searchTimer = null;
    let wsHandler = null;
    let wsConnected = false;
    let reconnectHandler = null;
    let lastTs = 0;
    let isPaused = false;
    let containerEl = container;

    // ─── Render UI ───

    function render() {
      containerEl.innerHTML = `
        <div class="panel" style="margin-top:8px">
          <div class="panel-header flex justify-between items-center flex-wrap gap-8">
            <span>&gt;_ logs</span>
            <div class="flex gap-8 items-center flex-wrap">
              <span id="${idPrefix}-live-indicator" class="text-dim fs-xs">
                <span class="text-err">&#9679;</span> connecting...
              </span>
              <button type="button" class="btn-console btn-sm ${idPrefix}-pause-btn">pause</button>
              <button type="button" class="btn-console btn-sm ${idPrefix}-refresh-btn">refresh</button>
            </div>
          </div>
          <div class="panel-body" style="padding:0">
            <div id="${idPrefix}-filters" style="padding:8px 12px;border-bottom:1px solid var(--border)" class="flex gap-8 items-center flex-wrap">
              ${filters.service ? `<div id="${idPrefix}-svc-btns" class="flex gap-4"></div>` : ''}
              ${filters.level ? `<div id="${idPrefix}-lvl-btns" class="flex gap-4"></div>` : ''}
              ${filters.timeRange ? `<div id="${idPrefix}-time-btns" class="flex gap-4"></div>` : ''}
              ${filters.search ? `<input type="text" class="form-input ${idPrefix}-search" placeholder="search..." autocomplete="off" style="padding:2px 8px;font-size:0.8rem;max-width:160px">` : ''}
              ${filters.lines ? `<select class="form-input ${idPrefix}-lines" style="padding:2px 6px;font-size:0.8rem"></select>` : ''}
            </div>
            <div id="${idPrefix}-viewer" style="max-height:60vh;overflow-y:auto;padding:8px 12px;font-size:0.82rem;line-height:1.5">
              <span class="text-dim">loading...</span>
            </div>
            <div id="${idPrefix}-info" class="text-dim" style="padding:6px 12px;border-top:1px solid var(--border);font-size:0.75rem"></div>
          </div>
        </div>`;
    }

    // ─── Filter controls ───

    function buildFilterButtons() {
      if (filters.service) {
        const wrap = document.getElementById(`${idPrefix}-svc-btns`);
        if (wrap) {
          wrap.innerHTML = services.map(s =>
            `<button type="button" class="btn-console btn-sm ${idPrefix}-svc-btn" data-val="${s}">${s === 'all' ? 'all' : shortSvc(s)}</button>`
          ).join('');
          syncBtnGroup(`.${idPrefix}-svc-btn`, activeService);
        }
      }

      if (filters.level) {
        const wrap = document.getElementById(`${idPrefix}-lvl-btns`);
        if (wrap) {
          wrap.innerHTML = LEVELS.map(l =>
            `<button type="button" class="btn-console btn-sm ${idPrefix}-lvl-btn" data-val="${l}">${l}</button>`
          ).join('');
          syncBtnGroup(`.${idPrefix}-lvl-btn`, activeLevel);
        }
      }

      if (filters.timeRange) {
        const wrap = document.getElementById(`${idPrefix}-time-btns`);
        if (wrap) {
          wrap.innerHTML = TIME_RANGES.map(t =>
            `<button type="button" class="btn-console btn-sm ${idPrefix}-time-btn" data-val="${t}">${t}</button>`
          ).join('');
          syncBtnGroup(`.${idPrefix}-time-btn`, activeTimeRange);
        }
      }

      if (filters.lines) {
        const sel = containerEl.querySelector(`.${idPrefix}-lines`);
        if (sel) {
          sel.innerHTML = LINE_OPTIONS.map(n =>
            `<option value="${n}"${n === activeLines ? ' selected' : ''}>${n} lines</option>`
          ).join('');
        }
      }
    }

    function syncBtnGroup(selector, activeVal) {
      containerEl.querySelectorAll(selector).forEach(btn => {
        btn.classList.toggle('btn-ok', btn.dataset.val === activeVal);
      });
    }

    // ─── Event binding ───

    function bindEvents() {
      containerEl.addEventListener('click', (e) => {
        const svcBtn = e.target.closest(`.${idPrefix}-svc-btn`);
        if (svcBtn) {
          activeService = svcBtn.dataset.val;
          syncBtnGroup(`.${idPrefix}-svc-btn`, activeService);
          applyFiltersAndRender();
          return;
        }

        const lvlBtn = e.target.closest(`.${idPrefix}-lvl-btn`);
        if (lvlBtn) {
          activeLevel = lvlBtn.dataset.val;
          syncBtnGroup(`.${idPrefix}-lvl-btn`, activeLevel);
          applyFiltersAndRender();
          return;
        }

        const timeBtn = e.target.closest(`.${idPrefix}-time-btn`);
        if (timeBtn) {
          activeTimeRange = timeBtn.dataset.val;
          syncBtnGroup(`.${idPrefix}-time-btn`, activeTimeRange);
          // Time range change needs fresh data from server
          loadInitial();
          return;
        }

        if (e.target.closest(`.${idPrefix}-refresh-btn`)) {
          loadInitial();
        }

        if (e.target.closest(`.${idPrefix}-pause-btn`)) {
          isPaused = !isPaused;
          const btn = e.target.closest(`.${idPrefix}-pause-btn`);
          btn.textContent = isPaused ? 'resume' : 'pause';
          updateLiveIndicator(wsConnected);
          if (!isPaused) applyFiltersAndRender();
        }
      });

      if (filters.search) {
        containerEl.querySelector(`.${idPrefix}-search`)?.addEventListener('input', (e) => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            activeSearch = e.target.value;
            applyFiltersAndRender();
          }, 300);
        });
      }

      if (filters.lines) {
        containerEl.querySelector(`.${idPrefix}-lines`)?.addEventListener('change', (e) => {
          activeLines = parseInt(e.target.value, 10) || 200;
          loadInitial();
        });
      }
    }

    // ─── WebSocket subscription ───

    function subscribeWs() {
      if (!wsChannel) return;

      wsHandler = (data) => {
        if (!data) return;

        // On reconnect, server may replay some entries; deduplicate by ts
        if (data.ts && data.ts <= lastTs) return;
        if (data.ts) lastTs = data.ts;

        // Append to buffer (oldest-first)
        logEntries.push(data);
        if (logEntries.length > maxEntries) {
          logEntries.splice(0, logEntries.length - maxEntries);
        }

        // Skip DOM updates when paused (buffer still accumulates)
        if (isPaused) return;

        // Append to DOM if matching current filters
        if (matchesFilters(data)) {
          appendEntryToViewer(data);
        }

        updateInfo();
      };

      WsClient.subscribe(wsChannel, wsHandler);

      // Reload historical data on reconnect to fill the gap
      reconnectHandler = () => {
        loadInitial();
        updateLiveIndicator(true);
      };
      WsClient.onReconnect(reconnectHandler);

      updateLiveIndicator(true);
    }

    function unsubscribeWs() {
      if (reconnectHandler) {
        WsClient.offReconnect(reconnectHandler);
        reconnectHandler = null;
      }
      if (wsHandler && wsChannel) {
        WsClient.unsubscribe(wsChannel, wsHandler);
        wsHandler = null;
      }
    }

    function updateLiveIndicator(connected) {
      wsConnected = connected;
      const el = document.getElementById(`${idPrefix}-live-indicator`);
      if (!el) return;
      if (isPaused) {
        el.innerHTML = '<span class="text-warn">&#9679;</span> paused';
      } else if (connected) {
        el.innerHTML = '<span class="text-ok">&#9679;</span> live';
      } else {
        el.innerHTML = '<span class="text-err">&#9679;</span> disconnected';
      }
    }

    // ─── Data loading ───

    async function loadInitial() {
      if (!apiEndpoint) return;
      const viewer = document.getElementById(`${idPrefix}-viewer`);
      if (!viewer) return;
      viewer.innerHTML = '<span class="text-dim">loading...</span>';

      try {
        const params = new URLSearchParams();
        params.set('lines', activeLines);
        if (activeService !== 'all') params.set('service', activeService);
        if (activeLevel !== 'all') params.set('level', activeLevel);
        if (activeTimeRange !== 'all') params.set('since', activeTimeRange);
        if (activeSearch) params.set('search', activeSearch);

        const result = await Api.get(`${apiEndpoint}?${params}`);

        // Replace buffer with historical data (server returns oldest-first from journalctl)
        logEntries.length = 0;
        const logs = result.logs || result || [];
        if (Array.isArray(logs)) {
          for (let i = 0; i < logs.length; i++) {
            logEntries.push(logs[i]);
            if (logs[i].ts && logs[i].ts > lastTs) lastTs = logs[i].ts;
          }
        }
        // Trim buffer
        if (logEntries.length > maxEntries) logEntries.length = maxEntries;

        applyFiltersAndRender();

        const info = document.getElementById(`${idPrefix}-info`);
        if (info && result.count != null) {
          info.textContent = `showing ${result.filtered ?? logEntries.length} of ${result.count} entries`;
        }
      } catch (err) {
        const viewer = document.getElementById(`${idPrefix}-viewer`);
        if (viewer) viewer.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      }
    }

    // ─── Filtering & rendering ───

    function matchesFilters(entry) {
      if (activeService !== 'all' && entry.service !== activeService) return false;
      if (activeLevel !== 'all' && entry.level !== activeLevel) return false;
      if (activeSearch && !(entry.message || '').toLowerCase().includes(activeSearch.toLowerCase())) return false;
      return true;
    }

    function applyFiltersAndRender() {
      const viewer = document.getElementById(`${idPrefix}-viewer`);
      if (!viewer) return;

      const filtered = logEntries.filter(matchesFilters);

      if (filtered.length === 0) {
        viewer.innerHTML = '<span class="text-dim">no matching logs</span>';
      } else {
        viewer.innerHTML = filtered.map(entry => renderEntry(entry)).join('');
      }

      // Scroll to bottom after full re-render
      viewer.scrollTop = viewer.scrollHeight;

      updateInfo();
    }

    function appendEntryToViewer(entry) {
      const viewer = document.getElementById(`${idPrefix}-viewer`);
      if (!viewer) return;

      // Remove "no matching logs" placeholder if present
      const placeholder = viewer.querySelector('.text-dim');
      if (placeholder && placeholder.textContent.includes('no matching logs')) {
        placeholder.remove();
      }

      const html = renderEntry(entry);
      viewer.insertAdjacentHTML('beforeend', html);

      // Trim DOM nodes if too many (keep ~2x maxEntries worth, remove oldest from top)
      while (viewer.children.length > maxEntries * 2) {
        viewer.removeChild(viewer.firstChild);
      }

      // Auto-scroll to bottom if user is near the bottom
      const nearBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 80;
      if (nearBottom) viewer.scrollTop = viewer.scrollHeight;
    }

    function renderEntry(entry) {
      const lvl = entry.level;
      const lvlClass = lvl === 'ERROR' ? 'text-err' : lvl === 'WARNING' ? 'text-warn' : lvl === 'DEBUG' ? 'text-muted' : '';
      const lvlBadge = lvl ? `<span class="${lvlClass}">[${esc(lvl)}]</span> ` : '';
      const svc = shortSvc(entry.service || '');
      const ts = entry.timestamp || '';
      const logger = entry.logger ? `<span class="text-muted">${esc(entry.logger)}:</span> ` : '';
      const msg = esc(entry.message || '');

      return `<div><span class="text-dim">${esc(ts)}</span> <span class="text-muted">${esc(svc)}</span> ${lvlBadge}${logger}${msg}</div>`;
    }

    function updateInfo() {
      const info = document.getElementById(`${idPrefix}-info`);
      if (!info) return;
      const filtered = logEntries.filter(matchesFilters).length;
      info.textContent = `buffer: ${logEntries.length} entries | showing: ${filtered}`;
    }

    // ─── Public API ───

    function destroy() {
      unsubscribeWs();
      clearTimeout(searchTimer);
      logEntries.length = 0;
      isPaused = false;
      if (containerEl) containerEl.innerHTML = '';
    }

    function setFilter(key, value) {
      switch (key) {
        case 'service': activeService = value; break;
        case 'level': activeLevel = value; break;
        case 'timeRange': activeTimeRange = value; break;
        case 'search': activeSearch = value; break;
        case 'lines': activeLines = value; break;
      }
      applyFiltersAndRender();
    }

    function appendEntries(entries) {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (entry.ts && entry.ts <= lastTs) continue;
        if (entry.ts) lastTs = entry.ts;
        logEntries.push(entry);
        if (logEntries.length > maxEntries) {
          logEntries.splice(0, logEntries.length - maxEntries);
        }
        if (matchesFilters(entry)) appendEntryToViewer(entry);
      }
      updateInfo();
    }

    // ─── Initialize ───

    render();
    buildFilterButtons();
    bindEvents();
    loadInitial().then(() => {
      subscribeWs();
    });

    return { destroy, setFilter, appendEntries };
  }

  return { create };
})();
