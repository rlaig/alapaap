'use strict';

const BacktestComponent = (() => {
  const API = '/api/backtest';
  const LS_KEY = 'bt_last_run';
  let wsHandler = null;
  let timerInterval = null;
  let currentTab = 'run';
  let strategies = [];
  let profiles = [];
  let historicalInfo = [];
  let activeJobs = [];
  let prevJobStatuses = {};
  let runs = [];
  let expandedRun = null;
  let compareSelected = new Set();
  let pendingDelete = null;
  let deleteTimeout = null;
  let downloadTfs = new Set();
  let dismissedJobs = new Set();

  function saveLastRun(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }

  function loadLastRun() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ── Main render ──

  function render(container) {
    container.innerHTML = `
      <div id="bt-jobs-banner" class="bt-jobs-banner"></div>
      <div class="bt-tabs" id="bt-tabs">
        <button class="bt-tab bt-tab-active" data-tab="run">&gt;_ run</button>
        <button class="bt-tab" data-tab="runs">&gt;_ past runs</button>
        <button class="bt-tab" data-tab="compare">&gt;_ compare</button>
        <button class="bt-tab" data-tab="data">&gt;_ historical data</button>
      </div>
      <div id="bt-tab-content"></div>`;

    document.getElementById('bt-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });

    loadInitialData();

    wsHandler = (data) => {
      const incoming = Array.isArray(data) ? data : [];
      let refreshRuns = false;
      let refreshHistorical = false;
      incoming.forEach((j) => {
        const prev = prevJobStatuses[j.id];
        if (prev === 'running' && j.status !== 'running') {
          if (j.type === 'backtest') refreshRuns = true;
          if (j.type === 'download' || j.type === 'update') refreshHistorical = true;
        }
        prevJobStatuses[j.id] = j.status;
        if (j.status !== 'running' && j.finishedAt && !dismissedJobs.has(j.id)) {
          const age = Date.now() - j.finishedAt;
          if (age > 15000) {
            dismissedJobs.add(j.id);
          } else {
            setTimeout(() => {
              dismissedJobs.add(j.id);
              renderJobsBanner();
            }, 15000 - age);
          }
        }
      });
      activeJobs = incoming;
      renderJobsBanner();
      if (refreshRuns && currentTab === 'runs') {
        const content = document.getElementById('bt-tab-content');
        if (content) renderRunsTab(content);
      }
      if (refreshHistorical) {
        Api.get(`${API}/historical-info`).then((info) => {
          historicalInfo = info || [];
          if (currentTab === 'historical') {
            const content = document.getElementById('bt-tab-content');
            if (content) renderHistoricalTab(content);
          }
        }).catch(() => {});
      }
    };
    WsClient.subscribe('backtest:jobs', wsHandler);

    timerInterval = setInterval(updateTimers, 1000);
  }

  async function loadInitialData() {
    try {
      const [strats, profs, hist, jobsList] = await Promise.all([
        Api.get(`${API}/strategies`),
        Api.get(`${API}/profiles`),
        Api.get(`${API}/historical-info`),
        Api.get(`${API}/jobs`),
      ]);
      strategies = strats || [];
      profiles = profs || [];
      historicalInfo = hist || [];
      activeJobs = jobsList || [];
      prevJobStatuses = {};
      activeJobs.forEach((j) => {
        prevJobStatuses[j.id] = j.status;
        if (j.status !== 'running' && j.finishedAt) {
          const age = Date.now() - j.finishedAt;
          if (age > 15000) dismissedJobs.add(j.id);
          else setTimeout(() => { dismissedJobs.add(j.id); renderJobsBanner(); }, 15000 - age);
        }
      });
      renderJobsBanner();
      switchTab(currentTab);
    } catch (err) {
      document.getElementById('bt-tab-content').innerHTML =
        `<span class="text-err">Failed to load: ${esc(err.message)}</span>`;
    }
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.bt-tab').forEach((t) => {
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab);
    });
    const content = document.getElementById('bt-tab-content');
    if (!content) return;
    if (tab === 'run') renderRunTab(content);
    else if (tab === 'runs') renderRunsTab(content);
    else if (tab === 'compare') renderCompareTab(content);
    else if (tab === 'data') renderDataTab(content);
  }

  // ── Jobs Banner ──

  function renderJobsBanner() {
    const el = document.getElementById('bt-jobs-banner');
    if (!el) return;
    if (!activeJobs.length) { el.innerHTML = ''; return; }

    const visible = activeJobs.filter((j) => !dismissedJobs.has(j.id));
    if (!visible.length) { el.innerHTML = ''; return; }

    el.innerHTML = visible.map((j) => {
      const isRunning = j.status === 'running';
      const isDone = !isRunning;
      const cls = `bt-job-card bt-job-${j.status}`;
      const timerCls = isRunning ? 'bt-job-timer' : 'bt-job-timer bt-job-timer-done';
      const elapsed = fmtElapsed(j.elapsed);
      const logLines = (j.output || []).slice(-3).map((l) => esc(l)).join('\n');

      let resultHtml = '';
      if (j.status === 'completed') {
        resultHtml = `<div class="bt-job-result bt-job-result-ok">completed</div>`;
      } else if (j.status === 'failed') {
        resultHtml = `<div class="bt-job-result bt-job-result-err">failed${j.result ? ': ' + esc(j.result) : ''}</div>`;
      } else if (j.status === 'cancelled') {
        resultHtml = `<div class="bt-job-result" style="color:var(--accent-amber)">cancelled</div>`;
      }

      const actionBtn = isRunning
        ? `<button class="btn-console btn-sm btn-err bt-job-cancel" data-job-id="${esc(j.id)}">cancel</button>`
        : `<button class="btn-icon bt-job-dismiss" data-job-id="${esc(j.id)}" title="dismiss">&times;</button>`;

      return `<div class="${cls}" data-job-id="${esc(j.id)}">
        <div class="bt-job-header">
          <span class="bt-job-type">${esc(j.type)}</span>
          <span class="bt-job-label">${esc(j.label)}</span>
          <span class="${timerCls}" data-started="${j.startedAt}" data-finished="${j.finishedAt || ''}">${elapsed}</span>
          ${actionBtn}
        </div>
        ${logLines ? `<div class="bt-job-log">${logLines}</div>` : ''}
        ${resultHtml}
      </div>`;
    }).join('');

    el.querySelectorAll('.bt-job-cancel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await Api.post(`${API}/jobs/${btn.dataset.jobId}/cancel`); } catch { /* ignore */ }
      });
    });

    el.querySelectorAll('.bt-job-dismiss').forEach((btn) => {
      btn.addEventListener('click', () => {
        dismissedJobs.add(btn.dataset.jobId);
        renderJobsBanner();
      });
    });
  }

  function updateTimers() {
    document.querySelectorAll('.bt-job-timer').forEach((el) => {
      const started = parseInt(el.dataset.started, 10);
      const finished = el.dataset.finished ? parseInt(el.dataset.finished, 10) : 0;
      if (!started) return;
      const ms = finished ? finished - started : Date.now() - started;
      el.textContent = fmtElapsed(ms);
    });
  }

  function hasActiveJobOfType(type) {
    return activeJobs.some((j) => j.type === type && j.status === 'running');
  }

  // ── Tab: Run Backtest ──

  function renderRunTab(container) {
    const availableTfs = historicalInfo.filter((h) => h.available);
    const tfOptions = availableTfs.map((h) =>
      `<option value="${esc(h.timeframe)}">${esc(h.timeframe)} (${fmtDate(h.minTs)} to ${fmtDate(h.maxTs)}, ${(h.rows || 0).toLocaleString()} rows)</option>`
    ).join('');

    const stratOptions = strategies.map((s) =>
      `<option value="${esc(s.name)}">${esc(s.name)} — ${esc(s.label)}</option>`
    ).join('');

    const profileOptions = profiles.map((p) => {
      const sn = p.config.strategy?.name || '?';
      return `<option value="${esc(p.name)}">${esc(p.name)} (${esc(sn)})</option>`;
    }).join('');

    const disabled = hasActiveJobOfType('backtest') ? 'disabled' : '';
    const btnLabel = hasActiveJobOfType('backtest') ? 'backtest in progress...' : 'run backtest';

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">&gt;_ configure backtest</div>
        <div class="panel-body">
          <div class="bt-form-row">
            <span class="bt-form-label">profile</span>
            <select class="bt-form-select" id="bt-profile">
              <option value="">none (manual config)</option>
              ${profileOptions}
            </select>
          </div>
          <div id="bt-profile-info"></div>
          <div class="bt-form-row">
            <span class="bt-form-label">strategy</span>
            <select class="bt-form-select" id="bt-strategy">${stratOptions}</select>
          </div>
          <div class="bt-form-row">
            <span class="bt-form-label">timeframe</span>
            <select class="bt-form-select" id="bt-timeframe">${tfOptions}</select>
          </div>
          <div class="bt-form-row">
            <span class="bt-form-label">start date</span>
            <input type="date" class="bt-form-input" id="bt-start" value="2024-01-01">
          </div>
          <div class="bt-form-row">
            <span class="bt-form-label">end date</span>
            <input type="date" class="bt-form-input" id="bt-end" value="2025-12-31">
          </div>
          <div class="bt-form-row">
            <span class="bt-form-label">capital (USDT)</span>
            <input type="number" class="bt-form-input" id="bt-capital" value="10000" min="100" step="100">
          </div>
          <div id="bt-mix-info"></div>
          <div>
            <button class="bt-params-toggle" id="bt-params-toggle">+ strategy parameters</button>
            <div id="bt-params-grid" class="bt-params-grid hidden"></div>
          </div>
          <div class="bt-form-row mt-16">
            <button class="btn-console btn-ok" id="bt-run-btn" ${disabled}>${btnLabel}</button>
          </div>
          <div id="bt-run-error" class="text-err mt-8" style="font-size:12px"></div>
        </div>
      </div>`;

    const profileEl = document.getElementById('bt-profile');
    const stratEl = document.getElementById('bt-strategy');
    const tfEl = document.getElementById('bt-timeframe');

    const saved = loadLastRun();
    if (saved) {
      if (saved.profile && profileEl.querySelector(`option[value="${saved.profile}"]`)) {
        profileEl.value = saved.profile;
      }
      if (saved.strategy && stratEl.querySelector(`option[value="${saved.strategy}"]`)) {
        stratEl.value = saved.strategy;
      }
      if (saved.timeframe && tfEl.querySelector(`option[value="${saved.timeframe}"]`)) {
        tfEl.value = saved.timeframe;
      }
      if (saved.start) document.getElementById('bt-start').value = saved.start;
      if (saved.end) document.getElementById('bt-end').value = saved.end;
      if (saved.capital) document.getElementById('bt-capital').value = saved.capital;
    }

    profileEl.addEventListener('change', () => applyProfileSelection());
    stratEl.addEventListener('change', () => { renderStrategyParams(); renderMixInfo(); });

    applyProfileSelection();
    renderStrategyParams();
    renderMixInfo();

    tfEl.addEventListener('change', () => constrainDates());
    constrainDates();

    document.getElementById('bt-params-toggle').addEventListener('click', () => {
      document.getElementById('bt-params-grid').classList.toggle('hidden');
    });

    document.getElementById('bt-run-btn').addEventListener('click', submitBacktest);
  }

  function applyProfileSelection() {
    const profileEl = document.getElementById('bt-profile');
    const stratEl = document.getElementById('bt-strategy');
    const infoEl = document.getElementById('bt-profile-info');
    if (!profileEl || !stratEl || !infoEl) return;

    const profileName = profileEl.value;
    const prof = profiles.find((p) => p.name === profileName);

    if (!prof) {
      stratEl.disabled = false;
      infoEl.innerHTML = '';
      renderMixInfo();
      return;
    }

    const cfg = prof.config;
    const sn = cfg.strategy?.name;
    if (sn && stratEl.querySelector(`option[value="${sn}"]`)) {
      stratEl.value = sn;
    }
    stratEl.disabled = true;
    renderStrategyParams();
    renderMixInfo();
    renderProfileInfo(infoEl, prof);
  }

  function renderProfileInfo(el, prof) {
    const cfg = prof.config;
    const strat = cfg.strategy || {};
    const sl = cfg.stop_loss || {};
    const risk = cfg.risk || {};
    const dyn = cfg.dynamic_sizing || {};
    const mtf = cfg.multi_timeframe || {};
    const tsw = cfg.tiered_stopwin || {};
    const sf = cfg.signal_filter || {};
    const cd = cfg.cooldown || {};

    const stratParams = Object.entries(strat)
      .filter(([k]) => k !== 'name' && k !== 'timeframe')
      .map(([k, v]) => `<span class="text-bright">${esc(k)}</span>=<span class="text-ok">${esc(String(v))}</span>`)
      .join(', ');

    const flags = [
      dyn.enabled ? '<span class="text-ok">dynamic sizing</span>' : '<span class="text-dim">no dynamic sizing</span>',
      mtf.enabled ? '<span class="text-ok">multi-timeframe</span>' : '<span class="text-dim">no multi-tf</span>',
      tsw.enabled ? '<span class="text-ok">tiered stopwin</span>' : '<span class="text-dim">no tiered stopwin</span>',
    ].join(' · ');

    el.innerHTML = `
      <div class="bt-profile-panel">
        <div class="bt-profile-title">profile: <span class="text-bright">${esc(prof.name)}</span></div>
        <div class="bt-profile-grid">
          <div class="bt-profile-section">strategy</div>
          <div><span class="text-bright">${esc(strat.name || '--')}</span>${stratParams ? ' — ' + stratParams : ''}</div>
          <div class="bt-profile-section">stop loss / take profit</div>
          <div>SL ATR: <span class="text-bright">${sl.atr_multiplier ?? '--'}</span> · TP ATR: <span class="text-bright">${sl.take_profit_atr_multiplier ?? '--'}</span> · min strength: <span class="text-bright">${sf.min_strength ?? '--'}</span></div>
          <div class="bt-profile-section">risk</div>
          <div>max position: <span class="text-bright">${risk.max_position_pct != null ? (risk.max_position_pct * 100).toFixed(0) + '%' : '--'}</span> · daily loss limit: <span class="text-bright">${risk.daily_loss_limit_pct != null ? (risk.daily_loss_limit_pct * 100).toFixed(1) + '%' : '--'}</span> · max trades: <span class="text-bright">${risk.max_open_trades ?? '--'}</span></div>
          <div class="bt-profile-section">flags</div>
          <div>${flags}</div>
          ${tsw.stoploss_pct ? `<div class="bt-profile-section">tiered stopwin</div><div>stoploss: <span class="text-bright">${tsw.stoploss_pct}%</span></div>` : ''}
          ${cd.min_seconds_between_trades ? `<div class="bt-profile-section">cooldown</div><div>min between trades: <span class="text-bright">${cd.min_seconds_between_trades}s</span> · confirm cycles: <span class="text-bright">${cd.confirm_cycles ?? '--'}</span></div>` : ''}
        </div>
      </div>`;
  }

  function renderMixInfo() {
    const name = document.getElementById('bt-strategy').value;
    const infoEl = document.getElementById('bt-mix-info');
    if (!infoEl) return;
    const strat = strategies.find((s) => s.name === name);
    if (!strat || !strat.isEnsemble) { infoEl.innerHTML = ''; return; }

    const subs = (strat.defaultSubs || []).map((s) => {
      const weightLabel = s.weight != null ? ` <span class="text-muted">(${s.weight})</span>` : '';
      return `<span class="bt-tf-tag bt-tf-tag-selected">${esc(s.name)}${weightLabel}</span>`;
    }).join(' ');

    let detailHtml = '';
    if (strat.name === 'mix') {
      const modes = {
        weighted: 'Score = sum(weight × strength). Fires when score ≥ threshold.',
        regime: 'MarketRegime selects active sub-strategies, then weighted vote within subset.',
        best: 'Strongest non-hold signal wins. No voting.',
        layered: 'Trigger/confirm pipeline. First strategy triggers, others confirm or veto.',
        adaptive: 'Rolling-Sharpe rebalances per-strategy weights over time.',
        aggressive: 'Lowest threshold, any single buy signal fires. High sensitivity mode.',
      };
      const modeList = (strat.blendModes || []).map((m) =>
        `<div style="margin:2px 0"><span class="text-bright">${esc(m)}</span> <span class="text-muted">— ${esc(modes[m] || '')}</span></div>`
      ).join('');
      detailHtml = `<div class="text-dim">Blend modes:</div>${modeList}`;
    } else if (strat.name === 'composite') {
      detailHtml = `
        <div class="text-dim">Voting ensemble — each sub-strategy votes buy/sell/hold independently.</div>
        <div style="margin:4px 0"><span class="text-bright">min_agree</span> <span class="text-muted">— minimum sub-strategies that must agree for a signal to fire.</span></div>
        <div style="margin:4px 0"><span class="text-bright">min_strength</span> <span class="text-muted">— minimum average signal strength across agreeing strategies.</span></div>`;
    }

    const allSubs = (strat.subStrategies || []).map((s) =>
      `<span class="bt-tf-tag">${esc(s)}</span>`
    ).join(' ');

    infoEl.innerHTML = `
      <div style="font-size:11px;margin-top:8px;padding:8px;border:1px solid var(--border);background:var(--bg-primary)">
        <div class="text-dim mb-8">Default subs: ${subs}</div>
        <div class="text-dim mb-8">Available subs: ${allSubs}</div>
        ${detailHtml}
      </div>`;
  }

  function renderStrategyParams() {
    const name = document.getElementById('bt-strategy').value;
    const strat = strategies.find((s) => s.name === name);
    const grid = document.getElementById('bt-params-grid');
    if (!grid || !strat) return;
    grid.innerHTML = strat.params.map((p) => {
      if (p.type === 'select') {
        const opts = (p.options || []).map((o) =>
          `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(o)}</option>`
        ).join('');
        return `<div class="bt-param-row">
          <span class="bt-param-label">${esc(p.key)}</span>
          <select class="bt-param-input bt-form-select" data-param="${esc(p.key)}" style="width:120px">${opts}</select>
        </div>`;
      }
      return `<div class="bt-param-row">
        <span class="bt-param-label">${esc(p.key)}</span>
        <input class="bt-param-input" data-param="${esc(p.key)}" type="number"
               placeholder="${p.default}" step="${p.type === 'float' ? '0.1' : '1'}">
      </div>`;
    }).join('');

    const saved = loadLastRun();
    if (saved && saved.strategy === name && saved.params) {
      grid.querySelectorAll('[data-param]').forEach((el) => {
        const key = el.dataset.param;
        if (saved.params[key] != null) el.value = saved.params[key];
      });
    }
  }

  function constrainDates() {
    const tf = document.getElementById('bt-timeframe')?.value;
    const info = historicalInfo.find((h) => h.timeframe === tf);
    if (!info || !info.minTs || !info.maxTs) return;
    const startEl = document.getElementById('bt-start');
    const endEl = document.getElementById('bt-end');
    const minDate = new Date(info.minTs).toISOString().split('T')[0];
    const maxDate = new Date(info.maxTs).toISOString().split('T')[0];
    if (startEl) { startEl.min = minDate; startEl.max = maxDate; }
    if (endEl) { endEl.min = minDate; endEl.max = maxDate; }
  }

  async function submitBacktest() {
    const errEl = document.getElementById('bt-run-error');
    errEl.textContent = '';
    const profileVal = document.getElementById('bt-profile').value;
    const body = {
      strategy: document.getElementById('bt-strategy').value,
      timeframe: document.getElementById('bt-timeframe').value,
      start: document.getElementById('bt-start').value,
      end: document.getElementById('bt-end').value,
      capital: Number(document.getElementById('bt-capital').value) || 10000,
    };
    if (profileVal) body.profile = profileVal;
    if (!body.strategy || !body.start || !body.end) {
      errEl.textContent = 'Please fill in all required fields';
      return;
    }

    const params = {};
    document.querySelectorAll('#bt-params-grid [data-param]').forEach((el) => {
      if (!el.value) return;
      const key = el.dataset.param;
      const val = el.tagName === 'SELECT' ? el.value : Number(el.value);
      if (val !== '' && val !== null) params[key] = val;
    });
    if (Object.keys(params).length) body.params = params;

    const btn = document.getElementById('bt-run-btn');
    btn.disabled = true;
    btn.textContent = 'starting...';

    try {
      await Api.post(`${API}/run`, body);
      saveLastRun(body);
      btn.textContent = 'backtest in progress...';
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'run backtest';
    }
  }

  // ── Tab: Past Runs ──

  async function renderRunsTab(container) {
    container.innerHTML = '<span class="text-dim">loading...</span>';
    try {
      runs = await Api.get(`${API}/runs`);
    } catch (err) {
      container.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      return;
    }

    if (!runs.length) {
      container.innerHTML = '<span class="text-dim">no backtest runs found. Run a backtest first.</span>';
      return;
    }

    const hdr = `<tr>
      <th>run</th><th>profile</th><th>tf</th><th>trades</th><th>win%</th><th>PnL</th>
      <th>return%</th><th>maxDD%</th><th>sharpe</th><th>PF</th><th>B&H%</th><th></th>
    </tr>`;

    const rows = runs.map((r) => {
      const m = r.metrics || {};
      const c = m.config || {};
      const pnl = m.total_pnl || 0;
      const prof = c.profile && c.profile !== 'custom' ? c.profile : '';
      const isExpanded = expandedRun === r.name;
      return `<tr class="bt-run-row" data-run="${esc(r.name)}" style="cursor:pointer">
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.name)}">${esc(r.name)}</td>
        <td>${prof ? `<span class="bt-profile-badge">${esc(prof)}</span>` : '<span class="text-muted">--</span>'}</td>
        <td class="text-dim">${esc(m.timeframe || '--')}</td>
        <td>${m.total_trades ?? '--'}</td>
        <td>${m.win_rate != null ? m.win_rate + '%' : '--'}</td>
        <td class="${pnlClass(pnl)}">${fmtPnl(pnl)}</td>
        <td class="${pnlClass(m.total_return_pct)}">${m.total_return_pct != null ? fmtSign(m.total_return_pct) + '%' : '--'}</td>
        <td>${m.max_drawdown_pct != null ? m.max_drawdown_pct + '%' : '--'}</td>
        <td>${m.sharpe_ratio ?? '--'}</td>
        <td>${m.profit_factor ?? '--'}</td>
        <td class="${pnlClass(m.buy_hold_return_pct)}">${m.buy_hold_return_pct != null ? fmtSign(m.buy_hold_return_pct) + '%' : '--'}</td>
        <td><button class="btn-console btn-sm btn-err bt-del-btn" data-run="${esc(r.name)}">del</button></td>
      </tr>
      ${isExpanded ? `<tr><td colspan="12" id="bt-run-detail-cell"></td></tr>` : ''}`;
    }).join('');

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ backtest runs (${runs.length})</span>
          <button class="btn-console btn-sm" id="bt-refresh-runs">refresh</button>
        </div>
        <div class="panel-body" style="overflow-x:auto;padding:0">
          <table class="table-console"><thead>${hdr}</thead><tbody>${rows}</tbody></table>
        </div>
      </div>
      <div id="bt-run-detail"></div>`;

    container.querySelectorAll('.bt-run-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.bt-del-btn')) return;
        const name = row.dataset.run;
        expandedRun = expandedRun === name ? null : name;
        renderRunsTab(container);
        if (expandedRun) loadRunDetail(expandedRun);
      });
    });

    container.querySelectorAll('.bt-del-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteRun(btn, container);
      });
    });

    document.getElementById('bt-refresh-runs')?.addEventListener('click', () => renderRunsTab(container));

    if (expandedRun) loadRunDetail(expandedRun);
  }

  function handleDeleteRun(btn, container) {
    const name = btn.dataset.run;
    if (pendingDelete === name) {
      doDeleteRun(name, container);
      return;
    }
    pendingDelete = name;
    btn.textContent = 'confirm?';
    if (deleteTimeout) clearTimeout(deleteTimeout);
    deleteTimeout = setTimeout(() => {
      pendingDelete = null;
      btn.textContent = 'del';
    }, 3000);
  }

  async function doDeleteRun(name, container) {
    pendingDelete = null;
    if (deleteTimeout) clearTimeout(deleteTimeout);
    try {
      await Api.delete(`${API}/runs/${encodeURIComponent(name)}`);
      if (expandedRun === name) expandedRun = null;
      renderRunsTab(container);
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async function loadRunDetail(name) {
    const detailEl = document.getElementById('bt-run-detail');
    if (!detailEl) return;
    detailEl.innerHTML = '<span class="text-dim">loading detail...</span>';

    try {
      const [metrics, trades, equity] = await Promise.all([
        Api.get(`${API}/runs/${encodeURIComponent(name)}/metrics`),
        Api.get(`${API}/runs/${encodeURIComponent(name)}/trades`),
        Api.get(`${API}/runs/${encodeURIComponent(name)}/equity`),
      ]);
      renderRunDetail(detailEl, name, metrics, trades, equity);
    } catch (err) {
      detailEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderRunDetail(el, name, m, trades, equity) {
    const sells = trades.filter((t) => t.side === 'sell');
    const sortedByPnl = [...sells].sort((a, b) => b.pnl - a.pnl);
    const best5 = sortedByPnl.slice(0, 5);
    const worst5 = sortedByPnl.slice(-5).reverse();

    let sparkHtml = '';
    if (equity.length > 1) {
      const eqs = equity.map((e) => e.equity);
      const minEq = Math.min(...eqs);
      const maxEq = Math.max(...eqs);
      const range = maxEq - minEq || 1;
      sparkHtml = `<div class="bt-equity-chart">${eqs.map((v) => {
        const pct = ((v - minEq) / range * 100).toFixed(1);
        return `<div class="bt-equity-bar" style="height:${Math.max(2, pct)}%"></div>`;
      }).join('')}</div>`;
    }

    const cfg = m.config || {};
    const stratCfg = m.strategy_config || {};
    const paramOverrides = m.param_overrides || {};

    let configHtml = '';
    const cfgEntries = Object.entries(cfg);
    const stratEntries = Object.entries(stratCfg).filter(([k]) => k !== 'name' && k !== 'timeframe');
    const overrideEntries = Object.entries(paramOverrides);
    if (stratEntries.length || cfgEntries.length || overrideEntries.length) {
      const renderKv = (entries) => entries.map(([k, v]) => {
        const display = Array.isArray(v)
          ? v.map((x) => typeof x === 'object' ? x.name || JSON.stringify(x) : x).join(', ')
          : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `<div class="bt-cfg-row"><span class="text-dim">${esc(k)}</span><span class="text-bright">${esc(display)}</span></div>`;
      }).join('');
      configHtml = `<div class="panel"><div class="panel-header">&gt;_ run configuration</div><div class="panel-body bt-cfg-grid">`;
      if (stratEntries.length) {
        configHtml += `<div class="bt-cfg-section"><span class="text-muted">strategy config</span></div>${renderKv(stratEntries)}`;
      }
      if (overrideEntries.length) {
        configHtml += `<div class="bt-cfg-section"><span class="text-accent">param overrides</span></div>${renderKv(overrideEntries)}`;
      }
      if (cfgEntries.length) {
        configHtml += `<div class="bt-cfg-section"><span class="text-muted">execution config</span></div>${renderKv(cfgEntries)}`;
      }
      configHtml += `</div></div>`;
    }

    const profileName = cfg.profile || null;
    const headerMeta = [
      m.strategy ? `<span class="text-bright">${esc(m.strategy)}</span>` : null,
      m.timeframe ? `<span class="text-dim">${esc(m.timeframe)}</span>` : null,
      m.start && m.end ? `<span class="text-dim">${esc(m.start)} to ${esc(m.end)}</span>` : null,
      profileName && profileName !== 'custom' ? `<span class="bt-profile-badge">${esc(profileName)}</span>` : null,
    ].filter(Boolean).join(' · ');

    el.innerHTML = `
      <div class="bt-run-detail">
        ${headerMeta ? `<div class="bt-run-header">${headerMeta}</div>` : ''}
        <div class="bt-kpi-row">
          ${kpiCard('final equity', `${fmtNum(m.final_equity)} USDT`, pnlClass(m.total_pnl))}
          ${kpiCard('total PnL', `${fmtPnl(m.total_pnl)} USDT`, pnlClass(m.total_pnl))}
          ${kpiCard('return', `${fmtSign(m.total_return_pct)}%`, pnlClass(m.total_return_pct))}
          ${kpiCard('win rate', `${m.win_rate}%`, m.win_rate >= 50 ? 'text-ok' : 'text-err')}
          ${kpiCard('trades', m.total_trades, 'text-bright')}
          ${kpiCard('avg PnL', `${fmtPnl(m.avg_pnl)} USDT`, pnlClass(m.avg_pnl))}
          ${kpiCard('sharpe', m.sharpe_ratio, m.sharpe_ratio > 0 ? 'text-ok' : 'text-err')}
          ${kpiCard('profit factor', m.profit_factor, 'text-bright')}
          ${kpiCard('max DD %', `${m.max_drawdown_pct}%`, 'text-err')}
          ${kpiCard('max DD', `${fmtNum(m.max_drawdown_usdt)} USDT`, 'text-err')}
          ${kpiCard('best trade', `${fmtPnl(m.best_trade)} USDT`, 'text-ok')}
          ${kpiCard('worst trade', `${fmtPnl(m.worst_trade)} USDT`, 'text-err')}
          ${kpiCard('losing streak', m.longest_losing_streak, m.longest_losing_streak > 5 ? 'text-err' : 'text-bright')}
          ${kpiCard('avg hold', `${m.avg_hold_candles ?? '--'} candles`, 'text-bright')}
          ${kpiCard('time in market', `${m.time_in_market_pct ?? '--'}%`, 'text-bright')}
          ${kpiCard('trades/day', m.trades_per_day ?? '--', 'text-bright')}
          ${kpiCard('B&H return', `${fmtSign(m.buy_hold_return_pct)}%`, pnlClass(m.buy_hold_return_pct))}
          ${kpiCard('beat B&H', m.total_return_pct > m.buy_hold_return_pct ? 'YES' : 'NO', m.total_return_pct > m.buy_hold_return_pct ? 'text-ok' : 'text-err')}
        </div>

        ${sparkHtml ? `<div class="panel"><div class="panel-header">&gt;_ equity curve</div><div class="panel-body">${sparkHtml}</div></div>` : ''}

        ${configHtml}

        <div class="grid grid-2">
          <div class="panel">
            <div class="panel-header">&gt;_ top 5 best trades</div>
            <div class="panel-body" style="overflow-x:auto;padding:0">${tradesTable(best5)}</div>
          </div>
          <div class="panel">
            <div class="panel-header">&gt;_ top 5 worst trades</div>
            <div class="panel-body" style="overflow-x:auto;padding:0">${tradesTable(worst5)}</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">&gt;_ all trades (${sells.length})</div>
          <div class="panel-body" style="overflow-x:auto;padding:0;max-height:400px;overflow-y:auto">${tradesTable(sells)}</div>
        </div>
      </div>`;
  }

  function kpiCard(label, value, cls) {
    return `<div class="bt-kpi"><div class="bt-kpi-value ${cls || ''}">${esc(String(value))}</div><div class="bt-kpi-label">${esc(label)}</div></div>`;
  }

  function tradesTable(trades) {
    if (!trades.length) return '<span class="text-dim" style="padding:12px;display:block">no trades</span>';
    const hdr = '<tr><th>#</th><th>time</th><th>entry</th><th>exit</th><th>qty</th><th>PnL</th><th>PnL%</th><th>strength</th><th>reason</th><th>hold</th><th>regime</th></tr>';
    const body = trades.map((t) =>
      `<tr>
        <td class="text-dim">${t.trade_id ?? '--'}</td>
        <td class="text-dim">${t.timestamp ? fmtTs(t.timestamp) : '--'}</td>
        <td>${esc(fmtNum(t.entry_price))}</td>
        <td>${esc(fmtNum(t.exit_price))}</td>
        <td class="text-dim">${t.qty != null ? Number(t.qty).toFixed(6) : '--'}</td>
        <td class="${pnlClass(t.pnl)}">${fmtPnl(t.pnl)}</td>
        <td class="${pnlClass(t.pnl_pct)}">${fmtSign(t.pnl_pct)}%</td>
        <td class="text-dim">${t.entry_strength != null ? Number(t.entry_strength).toFixed(3) : '--'}</td>
        <td class="text-dim">${esc(t.reason || '--')}</td>
        <td class="text-dim">${t.hold_candles || '--'}</td>
        <td class="text-dim">${esc(t.regime || '--')}</td>
      </tr>`
    ).join('');
    return `<table class="table-console">${hdr}${body}</table>`;
  }

  // ── Tab: Compare ──

  async function renderCompareTab(container) {
    if (!runs.length) {
      try { runs = await Api.get(`${API}/runs`); } catch { /* ignore */ }
    }
    if (!runs.length) {
      container.innerHTML = '<span class="text-dim">no runs to compare</span>';
      return;
    }

    const checkboxes = runs.map((r) =>
      `<label class="bt-check-label">
        <input type="checkbox" value="${esc(r.name)}" ${compareSelected.has(r.name) ? 'checked' : ''}>
        <span>${esc(r.name)}</span>
      </label>`
    ).join('');

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">&gt;_ select runs to compare (min 2)</div>
        <div class="panel-body">
          <div style="max-height:200px;overflow-y:auto">${checkboxes}</div>
          <div class="mt-8">
            <button class="btn-console btn-ok btn-sm" id="bt-compare-btn" ${compareSelected.size < 2 ? 'disabled' : ''}>compare</button>
            <button class="btn-console btn-sm" id="bt-compare-clear">clear</button>
          </div>
        </div>
      </div>
      <div id="bt-compare-result"></div>`;

    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) compareSelected.add(cb.value);
        else compareSelected.delete(cb.value);
        const btn = document.getElementById('bt-compare-btn');
        if (btn) btn.disabled = compareSelected.size < 2;
      });
    });

    document.getElementById('bt-compare-btn')?.addEventListener('click', doCompare);
    document.getElementById('bt-compare-clear')?.addEventListener('click', () => {
      compareSelected.clear();
      renderCompareTab(container);
    });
  }

  async function doCompare() {
    const el = document.getElementById('bt-compare-result');
    if (!el) return;
    el.innerHTML = '<span class="text-dim">comparing...</span>';

    try {
      const data = await Api.post(`${API}/compare`, { runs: Array.from(compareSelected) });
      if (!data.length) { el.innerHTML = '<span class="text-dim">no data</span>'; return; }
      renderCompareResult(el, data);
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderCompareResult(el, data) {
    const names = data.map((d) => d.name);
    const metrics = data.map((d) => d.metrics);

    const compareRows = [
      { label: 'Total PnL', key: 'total_pnl', fmt: 'pnl', higher: true },
      { label: 'Return %', key: 'total_return_pct', fmt: 'sign%', higher: true },
      { label: 'Win Rate %', key: 'win_rate', fmt: 'num', higher: true },
      { label: 'Total Trades', key: 'total_trades', fmt: 'int', higher: null },
      { label: 'Avg PnL/Trade', key: 'avg_pnl', fmt: 'pnl', higher: true },
      { label: 'Sharpe Ratio', key: 'sharpe_ratio', fmt: 'num3', higher: true },
      { label: 'Max Drawdown %', key: 'max_drawdown_pct', fmt: 'num', higher: false },
      { label: 'Max Drawdown USDT', key: 'max_drawdown_usdt', fmt: 'pnl', higher: false },
      { label: 'Profit Factor', key: 'profit_factor', fmt: 'num', higher: true },
      { label: 'Best Trade', key: 'best_trade', fmt: 'pnl', higher: true },
      { label: 'Worst Trade', key: 'worst_trade', fmt: 'pnl', higher: true },
      { label: 'Losing Streak', key: 'longest_losing_streak', fmt: 'int', higher: false },
      { label: 'Avg Hold Candles', key: 'avg_hold_candles', fmt: 'num', higher: null },
      { label: 'Trades/Day', key: 'trades_per_day', fmt: 'num', higher: null },
      { label: 'Time in Market %', key: 'time_in_market_pct', fmt: 'num', higher: null },
      { label: 'Buy&Hold Ret %', key: 'buy_hold_return_pct', fmt: 'sign%', higher: null },
    ];

    const nameCols = names.map((n) => `<th style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${esc(n)}">${esc(n.slice(0, 22))}</th>`).join('');
    const hdr = `<tr><th>metric</th>${nameCols}</tr>`;

    const body = compareRows.map((cr) => {
      const vals = metrics.map((m) => m[cr.key] ?? 0);
      let bestIdx = -1;
      if (cr.higher === true) bestIdx = vals.indexOf(Math.max(...vals));
      else if (cr.higher === false) bestIdx = vals.indexOf(Math.min(...vals));

      const cells = vals.map((v, i) => {
        const cls = i === bestIdx ? 'bt-compare-best' : '';
        let display;
        if (cr.fmt === 'pnl') display = fmtPnl(v);
        else if (cr.fmt === 'sign%') display = fmtSign(v) + '%';
        else if (cr.fmt === 'int') display = String(Math.round(v));
        else if (cr.fmt === 'num3') display = Number(v).toFixed(3);
        else display = String(v);
        return `<td class="${cls}">${esc(display)}</td>`;
      }).join('');
      return `<tr><td class="text-dim">${esc(cr.label)}</td>${cells}</tr>`;
    }).join('');

    el.innerHTML = `
      <div class="panel mt-16">
        <div class="panel-header">&gt;_ comparison (${names.length} strategies)</div>
        <div class="panel-body" style="overflow-x:auto;padding:0">
          <table class="table-console">${hdr}${body}</table>
        </div>
      </div>`;
  }

  // ── Tab: Historical Data ──

  async function renderDataTab(container) {
    try {
      historicalInfo = await Api.get(`${API}/historical-info`);
    } catch { /* use cached */ }

    const available = historicalInfo.filter((h) => h.available);
    const unavailable = historicalInfo.filter((h) => !h.available);

    const availRows = available.map((h) =>
      `<tr>
        <td class="text-bright">${esc(h.timeframe)}</td>
        <td>${(h.rows || 0).toLocaleString()}</td>
        <td class="text-dim">${fmtDate(h.minTs)}</td>
        <td class="text-dim">${fmtDate(h.maxTs)}</td>
        <td class="text-dim">${h.fileSize ? fmtFileSize(h.fileSize) : '--'}</td>
        <td class="text-dim">${h.updatedAt ? h.updatedAt.slice(0, 16) : '--'}</td>
        <td>
          <button class="btn-console btn-sm bt-update-tf" data-tf="${esc(h.timeframe)}"
                  ${hasActiveJobOfType('update') ? 'disabled' : ''}>update</button>
        </td>
      </tr>`
    ).join('');

    const dlDisabled = hasActiveJobOfType('download') ? 'disabled' : '';

    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">&gt;_ available historical data</div>
        <div class="panel-body" style="overflow-x:auto;padding:0">
          ${available.length ? `<table class="table-console">
            <tr><th>timeframe</th><th>rows</th><th>from</th><th>to</th><th>size</th><th>updated</th><th></th></tr>
            ${availRows}
          </table>` : '<span class="text-dim" style="padding:12px;display:block">no data downloaded yet</span>'}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">&gt;_ download new timeframes</div>
        <div class="panel-body">
          <div class="bt-form-row">
            <span class="bt-form-label">timeframes</span>
            <div id="bt-dl-tfs" class="bt-hist-actions">
              ${unavailable.map((h) =>
                `<span class="bt-tf-tag" data-tf="${esc(h.timeframe)}">${esc(h.timeframe)}</span>`
              ).join('')}
              ${available.map((h) =>
                `<span class="bt-tf-tag bt-tf-tag-selected" data-tf="${esc(h.timeframe)}">${esc(h.timeframe)}</span>`
              ).join('')}
            </div>
          </div>
          <div class="bt-form-row">
            <span class="bt-form-label">start month</span>
            <input type="month" class="bt-form-input" id="bt-dl-start" value="2024-01">
          </div>
          <div class="bt-form-row">
            <button class="btn-console btn-ok" id="bt-dl-btn" ${dlDisabled}>download selected</button>
            <span class="text-dim" style="font-size:11px">source: data.binance.vision (no API key needed)</span>
          </div>
          <div id="bt-dl-error" class="text-err mt-8" style="font-size:12px"></div>
        </div>
      </div>`;

    // Toggle timeframe selection for download
    downloadTfs.clear();
    container.querySelectorAll('#bt-dl-tfs .bt-tf-tag').forEach((tag) => {
      tag.addEventListener('click', () => {
        const tf = tag.dataset.tf;
        if (downloadTfs.has(tf)) {
          downloadTfs.delete(tf);
          tag.classList.remove('bt-tf-tag-selected');
        } else {
          downloadTfs.add(tf);
          tag.classList.add('bt-tf-tag-selected');
        }
      });
      // Pre-select unavailable ones by default (new downloads)
      if (unavailable.some((h) => h.timeframe === tag.dataset.tf)) {
        // Not selected by default — user picks what they want
      } else {
        // Already available — don't preselect for re-download
        tag.classList.remove('bt-tf-tag-selected');
      }
    });

    // Update buttons
    container.querySelectorAll('.bt-update-tf').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'starting...';
        try {
          await Api.post(`${API}/historical/update`, { timeframes: btn.dataset.tf });
        } catch (err) {
          App.toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'update';
        }
      });
    });

    // Download button
    document.getElementById('bt-dl-btn')?.addEventListener('click', async () => {
      const errEl = document.getElementById('bt-dl-error');
      errEl.textContent = '';
      if (!downloadTfs.size) { errEl.textContent = 'Select at least one timeframe'; return; }
      const startInput = document.getElementById('bt-dl-start');
      const start = startInput?.value || '2024-01';
      const btn = document.getElementById('bt-dl-btn');
      btn.disabled = true;
      btn.textContent = 'starting...';
      try {
        await Api.post(`${API}/historical/download`, {
          timeframes: Array.from(downloadTfs).join(','),
          start,
        });
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'download selected';
      }
    });
  }

  // ── Helpers ──

  function fmtNum(v) {
    if (v == null) return '--';
    const n = Number(v);
    if (Number.isNaN(n)) return '--';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPnl(v) {
    const n = Number(v) || 0;
    const s = n.toFixed(2);
    return n > 0 ? `+${s}` : s;
  }

  function fmtSign(v) {
    const n = Number(v) || 0;
    const s = n.toFixed(2);
    return n > 0 ? `+${s}` : s;
  }

  function pnlClass(v) {
    const n = Number(v) || 0;
    return n > 0 ? 'text-ok' : n < 0 ? 'text-err' : 'text-dim';
  }

  function fmtDate(ms) {
    if (!ms) return '--';
    return new Date(ms).toISOString().split('T')[0];
  }

  function fmtTs(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }

  function fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtElapsed(ms) {
    if (!ms || ms < 0) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function destroy() {
    if (wsHandler) {
      WsClient.unsubscribe('backtest:jobs', wsHandler);
      wsHandler = null;
    }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    pendingDelete = null;
    if (deleteTimeout) { clearTimeout(deleteTimeout); deleteTimeout = null; }
    dismissedJobs.clear();
  }

  return { render, destroy };
})();
