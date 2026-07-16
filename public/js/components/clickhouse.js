'use strict';

const ClickHouseComponent = (() => {
  let wsHandler = null;
  let selectedDb = '';
  let selectedTable = '';
  let lastPreview = null;

  function render(container) {
    container.innerHTML = `
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header">&gt;_ clickhouse status</div>
          <div class="panel-body-pre" id="ch-status">
            <span class="text-dim">loading...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ metrics</div>
          <div class="panel-body-pre" id="ch-metrics">
            <span class="text-dim">waiting for data...</span>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">&gt;_ databases</div>
        <div class="panel-body-pre" id="ch-databases">
          <span class="text-dim">loading...</span>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ storage &amp; retention</span>
          <button type="button" class="btn-console btn-sm" id="ch-st-refresh">refresh</button>
        </div>
        <div class="panel-body" id="ch-storage-body">
          <p class="text-dim mb-8">MergeTree-style tables: inspect size, preview rows/partitions older than <i>N</i> days, then drop partitions or run <code>ALTER DELETE</code> (guarded).</p>
          <div id="ch-storage-table-wrap" style="overflow-x:auto">
            <span class="text-dim">loading...</span>
          </div>
          <div class="mt-16 hidden" id="ch-ret-panel">
            <div class="panel-header text-dim" style="border:1px solid var(--color-rule);padding:8px;margin-bottom:8px">
              selected: <span id="ch-ret-sel" class="text-bright"></span>
            </div>
            <p class="text-dim mb-8" id="ch-ret-engine"></p>
            <p class="text-dim mb-8" id="ch-ret-ttl"></p>
            <div class="form-group">
              <label class="form-label">&gt;_ time column</label>
              <select class="form-input" id="ch-ret-col"></select>
            </div>
            <div class="form-group">
              <label class="form-label">&gt;_ older than (days)</label>
              <input type="number" class="form-input" id="ch-ret-days" min="1" max="3650" value="7" style="max-width:120px">
            </div>
            <div class="flex gap-8 mt-8">
              <button type="button" class="btn-console btn-ok" id="ch-ret-preview">[PREVIEW]</button>
            </div>
            <div class="mt-16 hidden" id="ch-ret-preview-out">
              <p id="ch-ret-preview-summary" class="text-dim mb-8"></p>
              <p id="ch-ret-part-note" class="text-dim mb-8"></p>
              <div id="ch-ret-parts-wrap" style="overflow-x:auto"></div>
              <div class="form-group mt-16">
                <label class="form-label">type <code>DELETE OLD DATA</code> to enable destructive actions</label>
                <input type="text" class="form-input" id="ch-ret-confirm" placeholder="DELETE OLD DATA" autocomplete="off">
              </div>
              <div class="flex gap-8 mt-8 flex-wrap">
                <button type="button" class="btn-console btn-warn" id="ch-ret-drop" disabled>DROP SELECTED PARTITIONS</button>
                <button type="button" class="btn-console btn-err" id="ch-ret-alter" disabled>ALTER DELETE MATCHING ROWS</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ maintenance <span id="ch-maint-badge" class="text-warn" style="display:none">[RUNNING]</span></span>
          <span class="flex gap-8">
            <button type="button" class="btn-console btn-sm" id="ch-maint-refresh">refresh</button>
            <button type="button" class="btn-console btn-sm btn-ok" id="ch-maint-run">run now</button>
            <button type="button" class="btn-console btn-sm btn-warn" id="ch-maint-flush">flush caches</button>
          </span>
        </div>
        <div class="panel-body">
          <div class="grid grid-2">
            <div>
              <p class="text-dim mb-8" style="font-weight:bold">scheduler</p>
              <div class="panel-body-pre" id="ch-maint-status"><span class="text-dim">loading...</span></div>
            </div>
            <div>
              <p class="text-dim mb-8" style="font-weight:bold">last run summary</p>
              <div class="panel-body-pre" id="ch-maint-last"><span class="text-dim">--</span></div>
            </div>
          </div>
          <div class="mt-16">
            <p class="text-dim mb-8" style="font-weight:bold">diagnostics</p>
            <div id="ch-maint-diag"><span class="text-dim">click refresh to load</span></div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">&gt;_ query editor</div>
        <div class="panel-body">
          <textarea id="ch-query-input" class="form-input" rows="4" placeholder="SELECT 1" style="resize:vertical"></textarea>
          <div class="flex gap-8 mt-8">
            <button class="btn-console btn-ok" id="ch-exec">[EXEC]</button>
            <span class="text-dim" id="ch-query-status"></span>
          </div>
          <div class="mt-8" id="ch-results"></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">&gt;_ recent queries</div>
        <div class="panel-body" id="ch-query-log" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>`;

    document.getElementById('ch-exec').addEventListener('click', execQuery);
    document.getElementById('ch-query-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') execQuery();
    });

    document.getElementById('ch-st-refresh').addEventListener('click', loadStorageOverview);
    document.getElementById('ch-ret-preview').addEventListener('click', runRetentionPreview);
    document.getElementById('ch-ret-drop').addEventListener('click', () => executeRetention('drop_partitions'));
    document.getElementById('ch-ret-alter').addEventListener('click', () => executeRetention('alter_delete'));
    document.getElementById('ch-ret-confirm').addEventListener('input', syncRetentionButtons);

    document.getElementById('ch-maint-refresh').addEventListener('click', loadMaintenancePanel);
    document.getElementById('ch-maint-run').addEventListener('click', runMaintenance);
    document.getElementById('ch-maint-flush').addEventListener('click', flushCaches);

    loadStatus();
    loadDatabases();
    loadStorageOverview();
    loadQueryLog();
    loadMaintenancePanel();

    wsHandler = (data) => renderMetrics(data);
    WsClient.subscribe('clickhouse:metrics', wsHandler);
  }

  async function loadStatus() {
    try {
      const data = await Api.get('/api/clickhouse-manager/status');
      const el = document.getElementById('ch-status');
      if (el) {
        el.innerHTML = data.alive
          ? `status  : <span class="text-ok">[OK]</span> connected\nversion : ${esc(data.version || '--')}`
          : `status  : <span class="text-err">[FAIL]</span> unreachable`;
      }
    } catch (err) {
      const el = document.getElementById('ch-status');
      if (el) el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function loadDatabases() {
    try {
      const data = await Api.get('/api/clickhouse-manager/databases');
      const el = document.getElementById('ch-databases');
      if (el && Array.isArray(data)) {
        el.innerHTML = data.map(db => {
          return `<span class="text-dim">├─</span> <a href="#" class="ch-db-link" data-db="${esc(db)}">${esc(db)}</a>`;
        }).join('\n') || '<span class="text-dim">no databases</span>';

        el.querySelectorAll('.ch-db-link').forEach(a => {
          a.addEventListener('click', async (e) => {
            e.preventDefault();
            const db = e.target.dataset.db;
            try {
              const tables = await Api.get(`/api/clickhouse-manager/databases/${encodeURIComponent(db)}/tables`);
              const tablesHtml = Array.isArray(tables) && tables.length
                ? tables.map(t => `   <span class="text-dim">├─</span> ${esc(t)}`).join('\n')
                : '   <span class="text-dim">  (empty)</span>';
              e.target.parentElement.innerHTML =
                `<span class="text-dim">├─</span> <span class="text-ok">${esc(db)}</span>\n${tablesHtml}`;
            } catch (err) {
              App.toast(`ERR: ${err.message}`, 'error');
            }
          });
        });
      }
    } catch (err) {
      const el = document.getElementById('ch-databases');
      if (el) el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function syncRetentionButtons() {
    const ok = document.getElementById('ch-ret-confirm')?.value === 'DELETE OLD DATA';
    const dropBtn = document.getElementById('ch-ret-drop');
    const alterBtn = document.getElementById('ch-ret-alter');
    if (dropBtn) dropBtn.disabled = !ok || !lastPreview;
    if (alterBtn) alterBtn.disabled = !ok || !lastPreview;
  }

  async function loadStorageOverview() {
    const wrap = document.getElementById('ch-storage-table-wrap');
    if (!wrap) return;
    const keepDb = selectedDb;
    const keepTb = selectedTable;
    wrap.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      const data = await Api.get('/api/clickhouse-manager/storage/overview');
      const rows = data.data || [];
      if (rows.length === 0) {
        wrap.innerHTML = '<span class="text-dim">no tables</span>';
        return;
      }
      const header = '<tr><th>database</th><th>table</th><th>engine</th><th>rows</th><th>size</th><th>partition key</th></tr>';
      const body = rows.map((r) => `<tr class="ch-st-row" data-db="${esc(r.database)}" data-table="${esc(r.name)}" style="cursor:pointer">
        <td>${esc(r.database)}</td><td>${esc(r.name)}</td><td class="text-dim">${esc(r.engine)}</td>
        <td class="text-dim">${r.total_rows ?? '--'}</td><td>${esc(r.readable_size || '')}</td><td class="text-dim">${esc(r.partition_key || '--')}</td>
      </tr>`).join('');
      wrap.innerHTML = `<table class="table-console">${header}${body}</table>`;
      wrap.querySelectorAll('.ch-st-row').forEach((row) => {
        row.addEventListener('click', () => {
          wrap.querySelectorAll('.ch-st-row').forEach((x) => { x.classList.remove('ch-st-row-selected'); });
          row.classList.add('ch-st-row-selected');
          selectRetentionTable(row.dataset.db, row.dataset.table);
        });
        if (keepDb && keepTb && row.dataset.db === keepDb && row.dataset.table === keepTb) {
          row.classList.add('ch-st-row-selected');
        }
      });
    } catch (err) {
      wrap.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function selectRetentionTable(db, table) {
    selectedDb = db;
    selectedTable = table;
    lastPreview = null;
    document.getElementById('ch-ret-panel')?.classList.remove('hidden');
    document.getElementById('ch-ret-sel').textContent = `${db}.${table}`;
    document.getElementById('ch-ret-preview-out')?.classList.add('hidden');
    document.getElementById('ch-ret-confirm').value = '';
    syncRetentionButtons();

    const engEl = document.getElementById('ch-ret-engine');
    const ttlEl = document.getElementById('ch-ret-ttl');
    const colSel = document.getElementById('ch-ret-col');
    if (!colSel) return;
    colSel.innerHTML = '';
    engEl.textContent = 'loading meta...';
    ttlEl.textContent = '';

    try {
      const meta = await Api.get(`/api/clickhouse-manager/storage/${encodeURIComponent(db)}/${encodeURIComponent(table)}`);
      engEl.textContent = `engine: ${meta.engine || '--'}${meta.distributed ? ' (distributed)' : ''}${meta.supportsPartitionDrop ? ' [partition drop ok]' : ''}`;
      ttlEl.textContent = meta.ttl ? `TTL: ${meta.ttl}` : 'TTL: (none found in engine_full / CREATE)';
      const cols = meta.timeColumns || [];
      if (cols.length === 0) {
        colSel.innerHTML = '<option value="">— no Date/DateTime columns —</option>';
      } else {
        colSel.innerHTML = cols.map((c) =>
          `<option value="${esc(c.name)}">${esc(c.name)} (${esc(c.type)})</option>`).join('');
      }
    } catch (err) {
      engEl.textContent = `ERR: ${err.message}`;
    }
  }

  async function runRetentionPreview() {
    const col = document.getElementById('ch-ret-col')?.value;
    const days = document.getElementById('ch-ret-days')?.value;
    if (!selectedDb || !selectedTable) {
      App.toast('select a table from the storage table', 'error');
      return;
    }
    if (!col) {
      App.toast('pick a time column', 'error');
      return;
    }
    const out = document.getElementById('ch-ret-preview-out');
    const summary = document.getElementById('ch-ret-preview-summary');
    const partsWrap = document.getElementById('ch-ret-parts-wrap');
    const partNote = document.getElementById('ch-ret-part-note');
    out?.classList.remove('hidden');
    summary.textContent = 'running preview...';
    partsWrap.innerHTML = '';
    partNote.textContent = '';

    try {
      const preview = await Api.post('/api/clickhouse-manager/storage/preview', {
        database: selectedDb,
        table: selectedTable,
        column: col,
        olderThanDays: parseInt(days, 10) || 7,
      });
      lastPreview = preview;
      const ad = preview.alterDelete?.rowCount ?? 0;
      const pr = preview.partitions?.eligible || [];
      summary.innerHTML = `<span class="text-ok">ALTER DELETE</span> would match <b>${esc(String(ad))}</b> row(s) (where <code>${esc(preview.column)}</code> &lt; cutoff). ` +
        `Eligible partitions (by max_date in parts): <b>${esc(String(pr.length))}</b>.`;

      partNote.textContent = preview.partitions?.note || '';

      if (pr.length > 0) {
        const ph = '<tr><th></th><th>partition</th><th>rows</th><th>bytes</th><th>max_date</th></tr>';
        const prow = pr.map((p) => `<tr>
          <td><input type="checkbox" class="ch-ret-pchk" value="${escAttr(p.partition)}"></td>
          <td class="text-dim">${esc(p.partition)}</td>
          <td>${esc(String(p.rows ?? ''))}</td>
          <td class="text-dim">${esc(String(p.bytes_on_disk ?? ''))}</td>
          <td class="text-dim">${esc(String(p.max_part_date ?? ''))}</td>
        </tr>`).join('');
        partsWrap.innerHTML = `<p class="text-dim mb-8">Select partitions to drop (fast); unchecked partitions stay.</p><table class="table-console">${ph}${prow}</table>`;
      } else {
        partsWrap.innerHTML = '<span class="text-dim">no eligible partitions for drop (or not MergeTree)</span>';
      }
      document.getElementById('ch-ret-confirm').value = '';
      syncRetentionButtons();
    } catch (err) {
      lastPreview = null;
      summary.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      syncRetentionButtons();
    }
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  async function executeRetention(action) {
    if (!lastPreview || !selectedDb || !selectedTable) return;
    const col = document.getElementById('ch-ret-col')?.value;
    const days = parseInt(document.getElementById('ch-ret-days')?.value, 10) || 7;
    if (document.getElementById('ch-ret-confirm')?.value !== 'DELETE OLD DATA') {
      App.toast('type DELETE OLD DATA in the confirmation field', 'error');
      return;
    }

    try {
      if (action === 'drop_partitions') {
        const checked = Array.from(document.querySelectorAll('.ch-ret-pchk:checked')).map((c) => c.value);
        if (checked.length === 0) {
          App.toast('select at least one partition', 'error');
          return;
        }
        const res = await Api.post('/api/clickhouse-manager/storage/execute', {
          confirm: 'DELETE OLD DATA',
          action: 'drop_partitions',
          database: selectedDb,
          table: selectedTable,
          olderThanDays: days,
          partitions: checked,
        });
        App.toast(`dropped ${res.dropped ?? 0} partition(s)`, 'ok');
      } else {
        const res = await Api.post('/api/clickhouse-manager/storage/execute', {
          confirm: 'DELETE OLD DATA',
          action: 'alter_delete',
          database: selectedDb,
          table: selectedTable,
          column: col,
          olderThanDays: days,
        });
        if (res.skipped) App.toast('no rows matched; no mutation sent', 'ok');
        else App.toast(`ALTER DELETE submitted (${res.rowsTargeted ?? 0} rows targeted)`, 'ok');
      }
      document.getElementById('ch-ret-confirm').value = '';
      lastPreview = null;
      syncRetentionButtons();
      await loadStorageOverview();
      if (selectedDb && selectedTable) await selectRetentionTable(selectedDb, selectedTable);
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async function execQuery() {
    const input = document.getElementById('ch-query-input');
    const sql = input.value.trim();
    if (!sql) return;

    const statusEl = document.getElementById('ch-query-status');
    const resultsEl = document.getElementById('ch-results');
    statusEl.textContent = 'executing...';
    resultsEl.innerHTML = '';

    try {
      const start = Date.now();
      const data = await Api.post('/api/clickhouse-manager/query', { sql });
      const elapsed = Date.now() - start;
      statusEl.textContent = `${data.rows ?? 0} rows in ${elapsed}ms`;

      if (data.data && data.data.length > 0) {
        const cols = data.meta ? data.meta.map(m => m.name) : Object.keys(data.data[0]);
        const header = '<tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
        const rows = data.data.map(row => {
          return '<tr>' + cols.map(c => `<td>${esc(String(row[c] ?? ''))}</td>`).join('') + '</tr>';
        }).join('');
        resultsEl.innerHTML = `<div style="overflow-x:auto"><table class="table-console">${header}${rows}</table></div>`;
      }
    } catch (err) {
      statusEl.textContent = '';
      resultsEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function loadQueryLog() {
    try {
      const data = await Api.get('/api/clickhouse-manager/query-log?limit=20');
      const el = document.getElementById('ch-query-log');
      if (el && Array.isArray(data) && data.length) {
        const header = '<tr><th>time</th><th>query</th><th>duration</th><th>rows</th></tr>';
        const rows = data.map(q => {
          const query = (q.query || '').slice(0, 80);
          return `<tr>
            <td class="text-dim">${esc(q.event_time || '--')}</td>
            <td>${esc(query)}</td>
            <td>${q.query_duration_ms ?? '--'}ms</td>
            <td>${q.read_rows ?? '--'}</td>
          </tr>`;
        }).join('');
        el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
      }
    } catch {
      // silent
    }
  }

  function syncMaintenanceRunning(isRunning) {
    const badge = document.getElementById('ch-maint-badge');
    const btn = document.getElementById('ch-maint-run');
    if (badge) badge.style.display = isRunning ? 'inline' : 'none';
    if (btn) {
      btn.disabled = isRunning;
      btn.textContent = isRunning ? 'running...' : 'run now';
    }
  }

  async function loadMaintenancePanel() {
    const statusEl = document.getElementById('ch-maint-status');
    const lastEl = document.getElementById('ch-maint-last');
    const diagEl = document.getElementById('ch-maint-diag');
    try {
      const [status, diag] = await Promise.all([
        Api.get('/api/clickhouse-manager/maintenance/status'),
        Api.get('/api/clickhouse-manager/maintenance/diagnostics'),
      ]);
      syncMaintenanceRunning(!!status.running);
      if (statusEl) {
        const lines = [];
        lines.push(`enabled  : ${status.enabled ? '<span class="text-ok">yes</span>' : '<span class="text-err">no</span>'}`);
        lines.push(`interval : ${Math.round((status.intervalMs || 0) / 60000)}m`);
        lines.push(`running  : ${status.running ? '<span class="text-warn">yes</span>' : 'no'}`);
        if (status.lastRunTime) lines.push(`last run : ${esc(status.lastRunTime)}`);
        if (status.nextRunApprox) lines.push(`next run : ${esc(status.nextRunApprox)}`);
        statusEl.innerHTML = lines.join('\n');
      }
      if (lastEl) {
        const lr = status.lastRun;
        if (!lr) {
          lastEl.innerHTML = '<span class="text-dim">no runs yet</span>';
        } else if (!lr.ok) {
          lastEl.innerHTML = `<span class="text-err">ERROR: ${esc(lr.error || 'unknown')}</span>\n${esc(lr.ts || '')} (${lr.durationMs ?? '--'}ms)`;
        } else {
          const ttlApplied = (lr.systemLogTTL || []).filter((r) => r.status === 'applied').length;
          const ttlTotal = (lr.systemLogTTL || []).length;
          const inact = (lr.inactivePartsCleanup || []).length;
          const opt = (lr.tableOptimization || []).length;
          lastEl.innerHTML = [
            `<span class="text-ok">[OK]</span> ${esc(lr.ts || '')} (${lr.durationMs ?? '--'}ms)`,
            `TTL enforced   : ${ttlApplied}/${ttlTotal} tables`,
            `inactive clean : ${inact} table(s) optimized`,
            `part merge     : ${opt} table(s) optimized`,
          ].join('\n');
        }
      }
      if (diagEl) renderDiagnostics(diagEl, diag);
    } catch (err) {
      if (statusEl) statusEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderDiagnostics(el, diag) {
    const sections = [];

    const ip = diag.inactiveParts || [];
    if (ip.length > 0) {
      const hdr = '<tr><th>database</th><th>table</th><th>inactive parts</th><th>bytes</th></tr>';
      const rows = ip.slice(0, 20).map((r) =>
        `<tr><td>${esc(r.database)}</td><td>${esc(r.table)}</td><td>${r.inactive_parts}</td><td class="text-dim">${r.inactive_bytes ?? '--'}</td></tr>`
      ).join('');
      sections.push(`<p class="text-dim mb-8">inactive parts (merged-away, pending cleanup)</p><div style="overflow-x:auto"><table class="table-console">${hdr}${rows}</table></div>`);
    } else {
      sections.push('<p class="text-dim mb-8">inactive parts: <span class="text-ok">none</span></p>');
    }

    const dp = diag.detachedParts || [];
    if (dp.length > 0) {
      const hdr = '<tr><th>database</th><th>table</th><th>count</th><th>bytes</th><th>reasons</th></tr>';
      const rows = dp.slice(0, 20).map((r) => {
        const reasons = Array.isArray(r.reasons) ? [...new Set(r.reasons)].join(', ') : '';
        return `<tr><td>${esc(r.database)}</td><td>${esc(r.table)}</td><td>${r.cnt}</td><td class="text-dim">${r.total_bytes ?? '--'}</td><td class="text-dim">${esc(reasons)}</td></tr>`;
      }).join('');
      sections.push(`<p class="text-dim mb-8 mt-16">detached parts (on disk, not queryable)</p><div style="overflow-x:auto"><table class="table-console">${hdr}${rows}</table></div>`);
    } else {
      sections.push('<p class="text-dim mb-8 mt-16">detached parts: <span class="text-ok">none</span></p>');
    }

    const sm = diag.staleMutations || [];
    if (sm.length > 0) {
      const hdr = '<tr><th>database</th><th>table</th><th>mutation_id</th><th>created</th><th>parts_to_do</th><th></th></tr>';
      const rows = sm.slice(0, 20).map((r) =>
        `<tr><td>${esc(r.database)}</td><td>${esc(r.table)}</td><td class="text-dim">${esc(r.mutation_id)}</td>` +
        `<td class="text-dim">${esc(r.create_time || '')}</td><td>${r.parts_to_do ?? '--'}</td>` +
        `<td><button class="btn-console btn-sm btn-err ch-kill-mut" data-db="${escAttr(r.database)}" data-table="${escAttr(r.table)}" data-mid="${escAttr(r.mutation_id)}">kill</button></td></tr>`
      ).join('');
      sections.push(`<p class="text-dim mb-8 mt-16">stale mutations (running &gt; threshold)</p><div style="overflow-x:auto"><table class="table-console">${hdr}${rows}</table></div>`);
    } else {
      sections.push('<p class="text-dim mb-8 mt-16">stale mutations: <span class="text-ok">none</span></p>');
    }

    const hp = diag.highPartTables || [];
    if (hp.length > 0) {
      const hdr = '<tr><th>database</th><th>table</th><th>active parts</th><th>bytes</th></tr>';
      const rows = hp.slice(0, 20).map((r) =>
        `<tr><td>${esc(r.database)}</td><td>${esc(r.table)}</td><td>${r.active_parts}</td><td class="text-dim">${r.total_bytes ?? '--'}</td></tr>`
      ).join('');
      sections.push(`<p class="text-dim mb-8 mt-16">high part-count tables</p><div style="overflow-x:auto"><table class="table-console">${hdr}${rows}</table></div>`);
    } else {
      sections.push('<p class="text-dim mb-8 mt-16">high part-count tables: <span class="text-ok">none</span></p>');
    }

    el.innerHTML = sections.join('');

    el.querySelectorAll('.ch-kill-mut').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Kill mutation ${btn.dataset.mid} on ${btn.dataset.db}.${btn.dataset.table}?`)) return;
        try {
          await Api.post('/api/clickhouse-manager/maintenance/mutations/kill', {
            database: btn.dataset.db,
            table: btn.dataset.table,
            mutationId: btn.dataset.mid,
          });
          App.toast('mutation killed', 'ok');
          loadMaintenancePanel();
        } catch (err) {
          App.toast(err.message, 'error');
        }
      });
    });
  }

  async function runMaintenance() {
    syncMaintenanceRunning(true);
    App.toast('maintenance cycle started...', 'ok');
    try {
      const result = await Api.post('/api/clickhouse-manager/maintenance/run', {});
      if (result.ok) {
        App.toast(`maintenance complete (${result.durationMs}ms)`, 'ok');
      } else if (result.skipped) {
        App.toast('a maintenance cycle is already in progress', 'error');
      } else {
        App.toast(`maintenance error: ${result.error || 'unknown'}`, 'error');
      }
      loadMaintenancePanel();
    } catch (err) {
      App.toast(err.message, 'error');
      syncMaintenanceRunning(false);
    }
  }

  async function flushCaches() {
    try {
      const res = await Api.post('/api/clickhouse-manager/maintenance/cache/flush', {});
      const ok = (res.results || []).filter((r) => r.status === 'ok').length;
      App.toast(`flushed ${ok} cache(s)`, 'ok');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  function renderMetrics(data) {
    const el = document.getElementById('ch-metrics');
    if (!el || !data) return;
    const lines = [];
    if (data.queries) lines.push(`queries    : ${data.queries}`);
    if (data.connections) lines.push(`connections: ${data.connections}`);
    if (data.memoryUsage) lines.push(`memory     : ${data.memoryUsage}`);
    if (data.merges) lines.push(`merges     : ${data.merges}`);
    el.innerHTML = lines.join('\n') || '<span class="text-dim">no metrics</span>';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function destroy() {
    if (wsHandler) {
      WsClient.unsubscribe('clickhouse:metrics', wsHandler);
      wsHandler = null;
    }
  }

  return { render, destroy };
})();
