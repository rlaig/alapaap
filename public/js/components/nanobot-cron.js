'use strict';

const NanobotCronComponent = (() => {
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
    el.textContent = desc ? `\u2192 ${desc}` : '';
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
          <div id="nc-table-wrap" style="overflow-x:auto"></div>
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
      const srcData = await Api.get('/api/nanobot-cron/sources');
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

      const st = await Api.get(`/api/nanobot-cron/status${sourceParam()}`);
      if (!st.configured) {
        statusEl.innerHTML = `Source <b>${esc(currentSource)}</b>: not configured.`;
        wrap.innerHTML = '';
        return;
      }
      storePath = st.path || '';
      const errCount = st.parseErrorCount || 0;
      const errBadge = errCount > 0 ? ` \u2014 <span class="text-err">${errCount} skipped (parse error)</span>` : '';
      statusEl.innerHTML = `File: <span class="text-dim">${esc(storePath)}</span> \u2014 ${st.jobCount ?? 0} job(s)${errBadge}`;

      const data = await Api.get(`/api/nanobot-cron/store${sourceParam()}`);
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
      await Api.patch(`/api/nanobot-cron/jobs/${encodeURIComponent(id)}${sourceParam()}`, { enabled });
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
      await Api.delete(`/api/nanobot-cron/jobs/${encodeURIComponent(id)}${sourceParam()}`);
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
        await Api.patch(`/api/nanobot-cron/jobs/${encodeURIComponent(editingId)}${sourceParam()}`, body);
        App.toast('saved', 'ok');
      } else {
        await Api.post(`/api/nanobot-cron/jobs${sourceParam()}`, {
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
