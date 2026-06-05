'use strict';

const TradingBotComponent = (() => {
  let wsHandler = null;
  const CK_API = '/api/trading-bot/ck';
  const TIME_RANGES = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: 'all', days: 3650 },
  ];
  let ckDays = 30;
  let pendingAction = null;
  let confirmTimeout = null;
  let cfgTab = 'base';
  let cfgCache = { base: null, strategy: null, merged: null };
  let profileList = [];
  let activeProfile = null;
  let pendingProfile = null;
  let profileConfirmTimeout = null;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function render(container) {
    container.innerHTML = `
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ bot status</span>
            <button class="btn-console btn-sm" id="tb-refresh-status">refresh</button>
          </div>
          <div class="panel-body" id="tb-status-body">
            <span class="text-dim">loading...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span>&gt;_ service control</span>
            <button class="btn-console btn-sm" id="tb-refresh-svc">refresh</button>
          </div>
          <div class="panel-body" id="tb-svc-body">
            <span class="text-dim">loading...</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ active parameters</span>
          <div class="flex gap-8 items-center">
            <span id="tb-profile-btns" class="flex gap-8 items-center"></span>
            <span id="tb-profile-confirm" class="hidden confirm-inline"></span>
            <button class="btn-console btn-sm" id="tb-refresh-params">refresh</button>
          </div>
        </div>
        <div class="panel-body" id="tb-params-body" style="overflow-x:auto">
          <span class="text-dim">loading...</span>
        </div>
      </div>

      <div class="tb-section-header">
        <span>&gt;_ clickhouse analytics</span>
        <div class="flex gap-8 items-center">
          <div id="tb-ck-time-btns" class="flex gap-8"></div>
          <button class="btn-console btn-sm" id="tb-ck-refresh-all">refresh all</button>
        </div>
      </div>

      <div id="tb-ck-kpis" class="grid grid-4 mb-16">
        <div class="panel"><div class="panel-header">&gt;_ total PnL</div><div class="panel-body tb-kpi" id="tb-kpi-pnl"><span class="text-dim">--</span></div></div>
        <div class="panel"><div class="panel-header">&gt;_ win rate</div><div class="panel-body tb-kpi" id="tb-kpi-winrate"><span class="text-dim">--</span></div></div>
        <div class="panel"><div class="panel-header">&gt;_ trades</div><div class="panel-body tb-kpi" id="tb-kpi-trades"><span class="text-dim">--</span></div></div>
        <div class="panel"><div class="panel-header">&gt;_ avg hold</div><div class="panel-body tb-kpi" id="tb-kpi-hold"><span class="text-dim">--</span></div></div>
      </div>

      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ trade pairs</span>
          <span class="text-dim" id="tb-tp-count"></span>
        </div>
        <div class="panel-body" id="tb-trade-pairs" style="overflow-x:auto;padding:0">
          <span class="text-dim" style="padding:12px;display:block">loading...</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">&gt;_ daily PnL</div>
        <div class="panel-body" id="tb-daily-pnl" style="overflow-x:auto;padding:0">
          <span class="text-dim" style="padding:12px;display:block">loading...</span>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header">&gt;_ win rate by strategy</div>
          <div class="panel-body" id="tb-wr-strategy" style="overflow-x:auto;padding:0">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ win rate by regime</div>
          <div class="panel-body" id="tb-wr-regime" style="overflow-x:auto;padding:0">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header">&gt;_ signal gate breakdown</div>
          <div class="panel-body" id="tb-gate-breakdown">
            <span class="text-dim">loading...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ signal strength vs outcome</div>
          <div class="panel-body" id="tb-strength" style="overflow-x:auto;padding:0">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header">&gt;_ hold duration: winners vs losers</div>
          <div class="panel-body" id="tb-hold-duration" style="overflow-x:auto;padding:0">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ equity snapshots</div>
          <div class="panel-body" id="tb-equity" style="overflow-x:auto;padding:0;max-height:340px;overflow-y:auto">
            <span class="text-dim" style="padding:12px;display:block">loading...</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ recent signals</span>
          <span class="text-dim" id="tb-sig-count"></span>
        </div>
        <div class="panel-body" id="tb-signals" style="overflow-x:auto;padding:0;max-height:400px;overflow-y:auto">
          <span class="text-dim" style="padding:12px;display:block">loading...</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">&gt;_ bot events</div>
        <div class="panel-body" id="tb-events" style="overflow-x:auto;padding:0;max-height:340px;overflow-y:auto">
          <span class="text-dim" style="padding:12px;display:block">loading...</span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ config files</span>
          <div class="flex gap-8">
            <button class="btn-console btn-sm tb-cfg-tab tb-cfg-tab-active" data-tab="base">paper.yaml</button>
            <button class="btn-console btn-sm tb-cfg-tab" data-tab="strategy">strategy.yaml</button>
            <button class="btn-console btn-sm tb-cfg-tab" data-tab="merged">merged</button>
            <button class="btn-console btn-sm" id="tb-refresh-config">refresh</button>
          </div>
        </div>
        <div class="panel-body-pre" id="tb-config-body" style="font-size:11px">
          <span class="text-dim">loading...</span>
        </div>
      </div>`;

    buildTimeButtons();
    document.getElementById('tb-refresh-status').addEventListener('click', loadStatus);
    document.getElementById('tb-refresh-svc').addEventListener('click', loadService);
    document.getElementById('tb-refresh-params').addEventListener('click', loadParams);
    document.getElementById('tb-refresh-config').addEventListener('click', loadConfig);
    document.getElementById('tb-ck-refresh-all').addEventListener('click', refreshCK);

    document.querySelectorAll('.tb-cfg-tab').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        cfgTab = e.target.dataset.tab;
        document.querySelectorAll('.tb-cfg-tab').forEach((b) =>
          b.classList.toggle('tb-cfg-tab-active', b.dataset.tab === cfgTab));
        renderConfigTab();
      });
    });

    loadStatus();
    loadService();
    loadProfiles();
    loadParams();
    loadConfig();
    refreshCK();

    wsHandler = (data) => {
      if (data && data.bot) renderStatus(data.bot);
      if (data && data.service) renderServiceBadge(data.service);
      if (data && 'activeProfile' in data) {
        activeProfile = data.activeProfile;
        renderProfileBadge();
        syncProfileButtons();
      }
    };
    WsClient.subscribe('trading-bot:status', wsHandler);
  }

  // ── Time Range ──

  function buildTimeButtons() {
    const wrap = document.getElementById('tb-ck-time-btns');
    if (!wrap) return;
    wrap.innerHTML = TIME_RANGES.map((r) =>
      `<button type="button" class="btn-console btn-sm tb-time-btn" data-days="${r.days}">${r.label}</button>`
    ).join('');
    syncTimeButtons();
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.tb-time-btn');
      if (!btn) return;
      ckDays = parseInt(btn.dataset.days, 10);
      syncTimeButtons();
      refreshCK();
    });
  }

  function syncTimeButtons() {
    document.querySelectorAll('.tb-time-btn').forEach((btn) => {
      btn.classList.toggle('tb-time-active', parseInt(btn.dataset.days, 10) === ckDays);
    });
  }

  // ── CK Refresh ──

  function refreshCK() {
    loadSummary();
    loadTradePairs();
    loadDailyPnl();
    loadWinRateStrategy();
    loadWinRateRegime();
    loadGateBreakdown();
    loadStrengthAnalysis();
    loadHoldDuration();
    loadEquity();
    loadSignals();
    loadEvents();
  }

  // ── KPI Summary ──

  async function loadSummary() {
    try {
      const s = await Api.get(`${CK_API}/summary?days=${ckDays}`);
      renderKpi('tb-kpi-pnl', fmtPnl(s.total_pnl), pnlClass(s.total_pnl),
        `avg ${fmtPnl(s.avg_pnl)} / best ${fmtPnl(s.best_trade)} / worst ${fmtPnl(s.worst_trade)}`);
      renderKpi('tb-kpi-winrate', `${s.win_rate_pct ?? '--'}%`,
        Number(s.win_rate_pct) >= 50 ? 'tb-pnl-pos' : 'tb-pnl-neg',
        `${s.wins ?? 0}W / ${s.losses ?? 0}L`);
      renderKpi('tb-kpi-trades', String(s.trade_count ?? 0), 'text-bright', '');
      renderKpi('tb-kpi-hold', `${s.avg_hold_min ?? '--'}m`, 'text-bright', '');
    } catch (err) {
      ['tb-kpi-pnl', 'tb-kpi-winrate', 'tb-kpi-trades', 'tb-kpi-hold'].forEach((id) => {
        setHtml(id, `<span class="text-err">ERR</span>`);
      });
    }
  }

  function renderKpi(id, value, cls, sub) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<div class="tb-kpi-value ${cls}">${esc(value)}</div>` +
      (sub ? `<div class="tb-kpi-sub">${esc(sub)}</div>` : '');
  }

  // ── Trade Pairs ──

  async function loadTradePairs() {
    const el = document.getElementById('tb-trade-pairs');
    try {
      const rows = await Api.get(`${CK_API}/trade-pairs?limit=50`);
      setHtml('tb-tp-count', rows.length ? `${rows.length} trades` : '');
      if (!rows.length) { el.innerHTML = dimBlock('no trade pairs found'); return; }
      const hdr = '<tr><th>entry</th><th>exit</th><th>strategy</th><th>entry $</th><th>exit $</th><th>PnL</th><th>exit reason</th><th>hold</th><th>regime</th><th>str</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.pnl) || 0;
        return `<tr>
          <td class="text-dim">${esc(fmtTs(r.entry_time))}</td>
          <td class="text-dim">${esc(fmtTs(r.exit_time))}</td>
          <td>${esc(r.strategy)}</td>
          <td>${esc(fmtNum(r.entry_price))}</td>
          <td>${esc(fmtNum(r.exit_price))}</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
          <td class="text-dim">${esc(r.exit_reason || '--')}</td>
          <td class="text-dim">${esc(fmtHold(r.hold_duration_s))}</td>
          <td class="text-dim">${esc(r.entry_regime || '--')}</td>
          <td class="text-dim">${esc(fmtStrength(r.entry_strength))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Daily PnL ──

  async function loadDailyPnl() {
    const el = document.getElementById('tb-daily-pnl');
    try {
      const rows = await Api.get(`${CK_API}/daily-pnl?days=${ckDays}`);
      if (!rows.length) { el.innerHTML = dimBlock('no daily PnL data'); return; }
      const hdr = '<tr><th>day</th><th>trades</th><th>PnL</th><th>win %</th><th>best</th><th>worst</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.daily_pnl) || 0;
        return `<tr>
          <td class="text-dim">${esc(r.day)}</td>
          <td>${esc(r.sell_count)}</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
          <td>${esc(r.win_rate_pct)}%</td>
          <td class="tb-pnl-pos">${esc(fmtPnl(r.best_trade))}</td>
          <td class="tb-pnl-neg">${esc(fmtPnl(r.worst_trade))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Win Rate by Strategy ──

  async function loadWinRateStrategy() {
    const el = document.getElementById('tb-wr-strategy');
    try {
      const rows = await Api.get(`${CK_API}/win-rate-strategy?days=${ckDays}`);
      if (!rows.length) { el.innerHTML = dimBlock('no strategy data'); return; }
      const hdr = '<tr><th>strategy</th><th>trades</th><th>wins</th><th>win %</th><th>PnL</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.total_pnl) || 0;
        return `<tr>
          <td>${esc(r.strategy)}</td>
          <td>${esc(r.trades)}</td>
          <td>${esc(r.wins)}</td>
          <td>${esc(r.win_rate_pct)}%</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Win Rate by Regime ──

  async function loadWinRateRegime() {
    const el = document.getElementById('tb-wr-regime');
    try {
      const rows = await Api.get(`${CK_API}/win-rate-regime`);
      if (!rows.length) { el.innerHTML = dimBlock('no regime data'); return; }
      const hdr = '<tr><th>regime</th><th>trades</th><th>win %</th><th>PnL</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.total_pnl) || 0;
        return `<tr>
          <td>${esc(r.market_regime)}</td>
          <td>${esc(r.trades)}</td>
          <td>${esc(r.win_rate_pct)}%</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Gate Breakdown ──

  const GATE_COLORS = {
    passed: 'var(--accent-green)',
    hold: 'var(--text-muted)',
    weak_signal: 'var(--accent-amber)',
    cooldown: 'var(--accent-blue)',
    confirmation_wait: '#8866ff',
    htf_blocked: 'var(--accent-red)',
    risk_blocked: '#ff6688',
    stop_loss: '#ff4466',
    take_profit: '#44ddaa',
    'n/a': 'var(--text-muted)',
  };

  async function loadGateBreakdown() {
    const el = document.getElementById('tb-gate-breakdown');
    try {
      const rows = await Api.get(`${CK_API}/gate-breakdown?days=${ckDays}`);
      if (!rows.length) { el.innerHTML = '<span class="text-dim">no gate data</span>'; return; }
      const total = rows.reduce((s, r) => s + Number(r.occurrences || 0), 0);
      const lines = rows.map((r) => {
        const pct = Number(r.pct) || 0;
        const color = GATE_COLORS[r.gate_result] || 'var(--text-dim)';
        const cls = r.gate_result === 'passed' ? 'tb-gate-passed' : 'tb-gate-blocked';
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="width:130px" class="${cls}">${esc(r.gate_result)}</span>
          <span style="flex:1;height:4px;background:var(--bg-primary);border-radius:2px;overflow:hidden">
            <span style="display:block;height:100%;width:${pct}%;background:${color}"></span>
          </span>
          <span class="text-dim" style="width:60px;text-align:right">${esc(r.occurrences)} (${esc(String(pct))}%)</span>
        </div>`;
      }).join('');
      el.innerHTML = `<div class="text-dim mb-8" style="font-size:11px">${total} buy signals evaluated</div>${lines}`;
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  // ── Strength Analysis ──

  async function loadStrengthAnalysis() {
    const el = document.getElementById('tb-strength');
    try {
      const rows = await Api.get(`${CK_API}/strength-analysis`);
      if (!rows.length) { el.innerHTML = dimBlock('no strength data'); return; }
      const hdr = '<tr><th>strength</th><th>trades</th><th>avg PnL</th><th>win %</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.avg_pnl) || 0;
        return `<tr>
          <td>${esc(r.strength_bucket)}</td>
          <td>${esc(r.trades)}</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
          <td>${esc(r.win_rate_pct)}%</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Hold Duration ──

  async function loadHoldDuration() {
    const el = document.getElementById('tb-hold-duration');
    try {
      const rows = await Api.get(`${CK_API}/hold-duration`);
      if (!rows.length) { el.innerHTML = dimBlock('no hold duration data'); return; }
      const hdr = '<tr><th>outcome</th><th>trades</th><th>avg (min)</th><th>min</th><th>max</th><th>avg PnL</th></tr>';
      const body = rows.map((r) => {
        const cls = r.outcome === 'win' ? 'tb-pnl-pos' : 'tb-pnl-neg';
        return `<tr>
          <td class="${cls}">${esc(r.outcome)}</td>
          <td>${esc(r.trades)}</td>
          <td>${esc(r.avg_hold_min)}</td>
          <td class="text-dim">${esc(r.min_hold_min)}</td>
          <td class="text-dim">${esc(r.max_hold_min)}</td>
          <td class="${pnlClass(r.avg_pnl)}">${esc(fmtPnl(r.avg_pnl))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Equity ──

  async function loadEquity() {
    const el = document.getElementById('tb-equity');
    const hours = ckDays * 24;
    try {
      const rows = await Api.get(`${CK_API}/equity?hours=${hours}`);
      if (!rows.length) { el.innerHTML = dimBlock('no equity snapshots'); return; }
      const hdr = '<tr><th>time</th><th>equity (USDT)</th><th>USDT</th><th>BTC</th><th>BTC price</th><th>PnL today</th><th>trades today</th></tr>';
      const body = rows.map((r) => {
        const pnl = Number(r.pnl_today) || 0;
        return `<tr class="tb-equity-row">
          <td class="text-dim">${esc(fmtTs(r.ts))}</td>
          <td class="text-bright">${esc(fmtNum(r.equity_usdt))}</td>
          <td class="text-dim">${esc(fmtNum(r.usdt_total))}</td>
          <td class="text-dim">${esc(String(r.btc_total ?? '--'))}</td>
          <td class="text-dim">${esc(fmtNum(r.btc_price))}</td>
          <td class="${pnlClass(pnl)}">${esc(fmtPnl(pnl))}</td>
          <td class="text-dim">${esc(String(r.trades_today ?? '--'))}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Recent Signals ──

  async function loadSignals() {
    const el = document.getElementById('tb-signals');
    try {
      const rows = await Api.get(`${CK_API}/signals?limit=50`);
      setHtml('tb-sig-count', rows.length ? `${rows.length} signals` : '');
      if (!rows.length) { el.innerHTML = dimBlock('no signals'); return; }
      const hdr = '<tr><th>time</th><th>symbol</th><th>strategy</th><th>signal</th><th>strength</th><th>price</th><th>regime</th><th>htf</th><th>gate</th><th>pos</th></tr>';
      const body = rows.map((r) => {
        const sigCls = r.signal === 'buy' ? 'tb-signal-buy' : r.signal === 'sell' ? 'tb-signal-sell' : 'tb-signal-hold';
        const gateCls = r.gate_result === 'passed' ? 'tb-gate-passed' : 'tb-gate-blocked';
        return `<tr>
          <td class="text-dim">${esc(fmtTs(r.ts))}</td>
          <td>${esc(r.symbol)}</td>
          <td class="text-dim">${esc(r.strategy)}</td>
          <td class="${sigCls}">${esc(r.signal)}</td>
          <td>${esc(fmtStrength(r.strength))}</td>
          <td>${esc(fmtNum(r.close_price))}</td>
          <td class="text-dim">${esc(r.market_regime || '--')}</td>
          <td class="text-dim">${esc(r.htf_trend || '--')}</td>
          <td class="${gateCls}" title="${esc(r.gate_detail || '')}">${esc(r.gate_result || '--')}</td>
          <td class="text-dim">${esc(r.position || '--')}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Bot Events ──

  async function loadEvents() {
    const el = document.getElementById('tb-events');
    try {
      const rows = await Api.get(`${CK_API}/events?limit=20`);
      if (!rows.length) { el.innerHTML = dimBlock('no bot events'); return; }
      const hdr = '<tr><th>time</th><th>type</th><th>severity</th><th>message</th></tr>';
      const body = rows.map((r) => {
        const sevCls = r.severity === 'error' ? 'tb-severity-error'
          : r.severity === 'warning' ? 'tb-severity-warning' : 'tb-severity-info';
        return `<tr>
          <td class="text-dim">${esc(fmtTs(r.ts))}</td>
          <td>${esc(r.event_type)}</td>
          <td class="${sevCls}">${esc(r.severity)}</td>
          <td style="white-space:normal;max-width:400px">${esc(r.message)}</td>
        </tr>`;
      }).join('');
      el.innerHTML = `<table class="table-console">${hdr}${body}</table>`;
    } catch (err) {
      el.innerHTML = errBlock(err);
    }
  }

  // ── Status Panel (kept from original) ──

  async function loadStatus() {
    try {
      const data = await Api.get('/api/trading-bot/status');
      renderStatus(data);
    } catch (err) {
      document.getElementById('tb-status-body').innerHTML =
        `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderStatus(s) {
    const el = document.getElementById('tb-status-body');
    if (!el || !s) return;

    const running = s.running
      ? '<span class="text-ok">[RUNNING]</span>'
      : '<span class="text-err">[STOPPED]</span>';

    const posClass = s.position === 'long' ? 'text-ok' : 'text-dim';
    const signalClass = s.last_signal === 'buy' ? 'text-ok'
      : s.last_signal === 'sell' ? 'text-err' : 'text-dim';
    const trendClass = s.higher_tf_trend === 'bullish' ? 'text-ok'
      : s.higher_tf_trend === 'bearish' ? 'text-err' : 'text-dim';
    const pnlVal = s.pnl_today || 0;
    const pnlCls = pnlVal > 0 ? 'text-ok' : pnlVal < 0 ? 'text-err' : 'text-dim';

    el.innerHTML = `<table class="table-console">
      <tr><td class="text-muted" style="width:130px">status</td><td>${running}</td></tr>
      <tr><td class="text-muted">position</td><td class="${posClass}">${esc(s.position || '--')}</td></tr>
      <tr><td class="text-muted">price</td><td>${esc(fmtNum(s.current_price))}</td></tr>
      <tr><td class="text-muted">entry</td><td>${esc(fmtNum(s.entry_price))}</td></tr>
      <tr><td class="text-muted">stop</td><td class="text-err">${esc(fmtNum(s.trailing_stop))}</td></tr>
      <tr><td class="text-muted">take profit</td><td class="text-ok">${esc(fmtNum(s.take_profit))}</td></tr>
      <tr><td class="text-muted">signal</td><td class="${signalClass}">${esc(s.last_signal || '--')} (${esc(fmtStrength(s.signal_strength))})</td></tr>
      <tr><td class="text-muted">strategy</td><td>${esc(s.strategy || '--')}</td></tr>
      <tr><td class="text-muted">profile</td><td id="tb-profile-badge"></td></tr>
      <tr><td class="text-muted">regime</td><td>${esc(s.market_regime || '--')}</td></tr>
      <tr><td class="text-muted">htf trend</td><td class="${trendClass}">${esc(s.higher_tf_trend || '--')}</td></tr>
      <tr><td class="text-muted">trades today</td><td>${esc(String(s.trades_today ?? '--'))}</td></tr>
      <tr><td class="text-muted">PnL today</td><td class="${pnlCls}">${esc(fmtPnl(pnlVal))} USDT</td></tr>
    </table>`;
    renderProfileBadge();
  }

  function renderProfileBadge() {
    const el = document.getElementById('tb-profile-badge');
    if (!el) return;
    if (activeProfile) {
      el.innerHTML = `<span class="text-ok">[${esc(activeProfile)}]</span>`;
    } else {
      el.innerHTML = '<span class="text-dim">[custom]</span>';
    }
  }

  // ── Profiles ──

  async function loadProfiles() {
    try {
      const data = await Api.get('/api/trading-bot/profiles');
      profileList = data.profiles || [];
      activeProfile = data.active;
      renderProfileButtons();
      renderProfileBadge();
    } catch {
      profileList = [];
      activeProfile = null;
    }
  }

  function renderProfileButtons() {
    const wrap = document.getElementById('tb-profile-btns');
    if (!wrap) return;
    if (!profileList.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = profileList.map((p) =>
      `<button class="btn-console btn-sm tb-profile-btn${p.name === activeProfile ? ' tb-profile-active' : ''}" data-profile="${esc(p.name)}">${esc(p.name)}</button>`
    ).join('');
    wrap.querySelectorAll('.tb-profile-btn').forEach((btn) => {
      btn.addEventListener('click', handleProfileClick);
    });
  }

  function syncProfileButtons() {
    document.querySelectorAll('.tb-profile-btn').forEach((btn) => {
      btn.classList.toggle('tb-profile-active', btn.dataset.profile === activeProfile);
    });
  }

  function handleProfileClick(e) {
    const name = e.target.dataset.profile;
    if (name === activeProfile) return;
    const confirmEl = document.getElementById('tb-profile-confirm');

    if (pendingProfile === name) {
      doApplyProfile(name);
      return;
    }

    pendingProfile = name;
    if (confirmEl) {
      confirmEl.classList.remove('hidden');
      confirmEl.innerHTML = `apply <strong>${esc(name)}</strong>? click again`;
    }

    if (profileConfirmTimeout) clearTimeout(profileConfirmTimeout);
    profileConfirmTimeout = setTimeout(() => {
      pendingProfile = null;
      if (confirmEl) confirmEl.classList.add('hidden');
    }, 3000);
  }

  async function doApplyProfile(name) {
    const confirmEl = document.getElementById('tb-profile-confirm');
    pendingProfile = null;
    if (profileConfirmTimeout) clearTimeout(profileConfirmTimeout);
    if (confirmEl) {
      confirmEl.classList.remove('hidden');
      confirmEl.textContent = 'applying...';
    }

    try {
      await Api.post(`/api/trading-bot/profiles/${encodeURIComponent(name)}/apply`);
      activeProfile = name;
      syncProfileButtons();
      renderProfileBadge();
      if (confirmEl) {
        confirmEl.innerHTML = `<span class="text-ok">applied ${esc(name)}</span>`;
        setTimeout(() => confirmEl.classList.add('hidden'), 2000);
      }
      loadParams();
      loadConfig();
    } catch (err) {
      if (confirmEl) {
        confirmEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
        setTimeout(() => confirmEl.classList.add('hidden'), 3000);
      }
    }
  }

  // ── Service Panel (kept from original) ──

  async function loadService() {
    const el = document.getElementById('tb-svc-body');
    try {
      const data = await Api.get('/api/trading-bot/service');
      renderService(data);
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderServiceBadge(svc) {
    const badge = document.getElementById('tb-svc-state');
    if (!badge || !svc) return;
    const active = svc.ActiveState === 'active';
    badge.className = active ? 'text-ok' : 'text-err';
    badge.textContent = `[${(svc.ActiveState || 'unknown').toUpperCase()}/${(svc.SubState || '?')}]`;
  }

  function renderService(data) {
    const el = document.getElementById('tb-svc-body');
    if (!el) return;

    const active = data.ActiveState === 'active';
    const badge = active
      ? `<span class="text-ok">[${esc(data.ActiveState)}/${esc(data.SubState)}]</span>`
      : `<span class="text-err">[${esc(data.ActiveState || 'unknown')}/${esc(data.SubState || '?')}]</span>`;

    const memBytes = parseInt(data.MemoryCurrent, 10);
    const memMb = memBytes > 0 ? (memBytes / 1024 / 1024).toFixed(1) + ' MB' : '--';
    const pid = data.MainPID && data.MainPID !== '0' ? data.MainPID : '--';
    const since = data.StateChangeTimestamp || '--';

    el.innerHTML = `
      <table class="table-console mb-8">
        <tr><td class="text-muted" style="width:130px">state</td><td><span id="tb-svc-state">${badge}</span></td></tr>
        <tr><td class="text-muted">PID</td><td class="text-dim">${esc(pid)}</td></tr>
        <tr><td class="text-muted">memory</td><td>${esc(memMb)}</td></tr>
        <tr><td class="text-muted">since</td><td class="text-dim">${esc(since)}</td></tr>
      </table>
      <div class="flex gap-8 mt-8">
        <button class="btn-console btn-sm btn-ok tb-svc-ctl" data-action="start">start</button>
        <button class="btn-console btn-sm btn-err tb-svc-ctl" data-action="stop">stop</button>
        <button class="btn-console btn-sm btn-warn tb-svc-ctl" data-action="restart">restart</button>
        <span id="tb-svc-confirm" class="hidden confirm-inline"></span>
      </div>`;

    el.querySelectorAll('.tb-svc-ctl').forEach((btn) => {
      btn.addEventListener('click', handleServiceAction);
    });
  }

  function handleServiceAction(e) {
    const action = e.target.dataset.action;
    const confirmEl = document.getElementById('tb-svc-confirm');

    if (pendingAction === action) {
      doServiceAction(action);
      return;
    }

    pendingAction = action;
    confirmEl.classList.remove('hidden');
    confirmEl.innerHTML = `click <strong>${esc(action)}</strong> again to confirm`;

    if (confirmTimeout) clearTimeout(confirmTimeout);
    confirmTimeout = setTimeout(() => {
      pendingAction = null;
      confirmEl.classList.add('hidden');
    }, 3000);
  }

  async function doServiceAction(action) {
    const confirmEl = document.getElementById('tb-svc-confirm');
    pendingAction = null;
    if (confirmTimeout) clearTimeout(confirmTimeout);
    if (confirmEl) {
      confirmEl.classList.remove('hidden');
      confirmEl.textContent = `${action}ing...`;
    }

    try {
      await Api.post(`/api/trading-bot/service/${action}`);
      if (confirmEl) {
        confirmEl.innerHTML = `<span class="text-ok">${esc(action)} done</span>`;
        setTimeout(() => confirmEl.classList.add('hidden'), 2000);
      }
      setTimeout(loadService, 1000);
    } catch (err) {
      if (confirmEl) {
        confirmEl.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      }
    }
  }

  // ── Active Parameters Panel ──

  async function loadParams() {
    const el = document.getElementById('tb-params-body');
    try {
      const cfg = await Api.get('/api/trading-bot/config/merged');
      renderParams(cfg);
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderParams(cfg) {
    const el = document.getElementById('tb-params-body');
    if (!el || !cfg) return;

    const sections = [];

    if (cfg.trading) {
      sections.push({ label: 'trading', rows: [
        ['symbol', cfg.trading.symbol],
        ['order_type', cfg.trading.order_type],
        ['default_qty', cfg.trading.default_qty],
        ['paper_mode', cfg.trading.paper_mode],
        ['check_interval_s', cfg.trading.check_interval_s],
      ]});
    }

    if (cfg.strategy) {
      const stratRows = Object.entries(cfg.strategy).map(([k, v]) => [k, v]);
      sections.push({ label: 'strategy', rows: stratRows });
    }

    if (cfg.signal_filter) {
      sections.push({ label: 'signal filter', rows: [
        ['min_strength', cfg.signal_filter.min_strength],
      ]});
    }

    if (cfg.stop_loss) {
      sections.push({ label: 'stop loss / take profit', rows: [
        ['atr_multiplier', cfg.stop_loss.atr_multiplier],
        ['take_profit_atr_multiplier', cfg.stop_loss.take_profit_atr_multiplier],
      ]});
    }

    if (cfg.dynamic_sizing) {
      sections.push({ label: 'dynamic sizing', rows: [
        ['enabled', cfg.dynamic_sizing.enabled],
        ['min_multiplier', cfg.dynamic_sizing.min_multiplier],
        ['max_multiplier', cfg.dynamic_sizing.max_multiplier],
      ]});
    }

    if (cfg.multi_timeframe) {
      sections.push({ label: 'multi timeframe', rows: [
        ['enabled', cfg.multi_timeframe.enabled],
      ]});
    }

    if (cfg.cooldown) {
      sections.push({ label: 'cooldown', rows: [
        ['min_seconds_between_trades', cfg.cooldown.min_seconds_between_trades],
        ['confirm_cycles', cfg.cooldown.confirm_cycles],
      ]});
    }

    if (cfg.tiered_stopwin) {
      sections.push({ label: 'tiered stopwin', rows: [
        ['enabled', cfg.tiered_stopwin.enabled],
        ['stoploss_pct', cfg.tiered_stopwin.stoploss_pct],
      ]});
    }

    if (cfg.risk) {
      sections.push({ label: 'risk', rows: [
        ['max_position_pct', cfg.risk.max_position_pct],
        ['daily_loss_limit_pct', cfg.risk.daily_loss_limit_pct],
        ['max_open_trades', cfg.risk.max_open_trades],
      ]});
    }

    if (cfg.clickhouse) {
      sections.push({ label: 'clickhouse logging', rows: [
        ['enabled', cfg.clickhouse.enabled],
        ['host', cfg.clickhouse.host],
        ['port', cfg.clickhouse.port],
        ['database', cfg.clickhouse.database],
        ['buffer_size', cfg.clickhouse.buffer_size],
        ['flush_interval_s', cfg.clickhouse.flush_interval_s],
      ]});
    }

    const html = sections.map((s) => {
      const hdr = `<tr><td colspan="2" class="tb-param-section">${esc(s.label)}</td></tr>`;
      const rows = s.rows.map(([k, v]) => {
        let display = v;
        let cls = '';
        if (v === true) { display = 'true'; cls = 'text-ok'; }
        else if (v === false) { display = 'false'; cls = 'text-err'; }
        else if (v == null) { display = '--'; cls = 'text-dim'; }
        else { display = String(v); }
        return `<tr><td class="text-muted" style="width:220px;padding-left:16px">${esc(k)}</td><td class="${cls}">${esc(display)}</td></tr>`;
      }).join('');
      return hdr + rows;
    }).join('');

    el.innerHTML = `<table class="table-console">${html}</table>`;
  }

  // ── Config Panel (tabbed) ──

  async function loadConfig() {
    const el = document.getElementById('tb-config-body');
    try {
      const [base, strat, merged] = await Promise.all([
        Api.get('/api/trading-bot/config'),
        Api.get('/api/trading-bot/config/strategy').catch(() => ({ config: null })),
        Api.get('/api/trading-bot/config/merged').catch(() => null),
      ]);
      cfgCache.base = base.config || '(empty)';
      cfgCache.strategy = strat.config || '(no strategy.yaml found)';
      cfgCache.merged = merged ? JSON.stringify(merged, null, 2) : '(not available)';
      renderConfigTab();
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderConfigTab() {
    const el = document.getElementById('tb-config-body');
    if (!el) return;
    const content = cfgCache[cfgTab];
    if (content) {
      el.textContent = content;
    } else {
      el.innerHTML = '<span class="text-dim">loading...</span>';
    }
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
    const s = n.toFixed(4);
    return n > 0 ? `+${s}` : s;
  }

  function fmtStrength(v) {
    if (v == null) return '--';
    return (Number(v) || 0).toFixed(2);
  }

  function fmtTs(ts) {
    if (!ts) return '--';
    return String(ts).replace('T', ' ').replace(/\.\d+$/, '').slice(0, 19);
  }

  function fmtHold(seconds) {
    if (seconds == null) return '--';
    const s = Number(seconds);
    if (Number.isNaN(s) || s <= 0) return '--';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  }

  function pnlClass(v) {
    const n = Number(v) || 0;
    return n > 0 ? 'tb-pnl-pos' : n < 0 ? 'tb-pnl-neg' : 'tb-pnl-zero';
  }

  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function dimBlock(msg) {
    return `<span class="text-dim" style="padding:12px;display:block">${esc(msg)}</span>`;
  }

  function errBlock(err) {
    return `<span class="text-err" style="padding:12px;display:block">ERR: ${esc(err.message)}</span>`;
  }

  function destroy() {
    pendingAction = null;
    pendingProfile = null;
    if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
    if (profileConfirmTimeout) { clearTimeout(profileConfirmTimeout); profileConfirmTimeout = null; }
    if (wsHandler) {
      WsClient.unsubscribe('trading-bot:status', wsHandler);
      wsHandler = null;
    }
  }

  return { render, destroy };
})();
