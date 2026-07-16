'use strict';

const NetworkCheckComponent = (() => {
  function render(container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ network overview</span>
          <button class="btn-console btn-sm" id="nc-refresh-overview">refresh</button>
        </div>
        <div class="panel-body-pre text-dim" id="nc-overview">loading...</div>
      </div>
      <div class="panel mt-16">
        <div class="panel-header flex justify-between items-center">
          <span>&gt;_ local listeners (TCP)</span>
          <span class="text-dim">from /proc/net/tcp*</span>
        </div>
        <div class="panel-body scroll-x" id="nc-listeners">
          <span class="text-dim">loading...</span>
        </div>
      </div>
      <div class="panel mt-16">
        <div class="panel-header">&gt;_ remote port check (single)</div>
        <div class="panel-body">
          <p class="text-dim mb-8" id="nc-policy"></p>
          <div class="flex flex-wrap gap-8 items-center mb-8">
            <input type="text" class="form-input" id="nc-host" placeholder="host e.g. 127.0.0.1" style="min-width:180px">
            <input type="number" class="form-input" id="nc-port" placeholder="port" min="1" max="65535" style="width:100px">
            <button class="btn-console btn-sm" id="nc-tcp-go">check</button>
          </div>
          <div class="panel-body-pre" id="nc-tcp-out"><span class="text-dim">result appears here</span></div>
        </div>
      </div>
      <div class="panel mt-16">
        <div class="panel-header">&gt;_ services on ports (batch)</div>
        <div class="panel-body">
          <p class="text-dim mb-8">Comma-separated ports (max 32). Same host restrictions as single check.</p>
          <div class="flex flex-wrap gap-8 items-center mb-8">
            <input type="text" class="form-input" id="nc-host-batch" placeholder="host" style="min-width:180px">
            <input type="text" class="form-input" id="nc-ports" placeholder="22,80,443,3000,8123" style="min-width:220px;flex:1">
            <button class="btn-console btn-sm" id="nc-ports-go">scan</button>
          </div>
          <div class="panel-body scroll-x" id="nc-ports-out">
            <span class="text-dim">results table appears here</span>
          </div>
        </div>
      </div>`;

    document.getElementById('nc-refresh-overview').addEventListener('click', () => {
      loadOverview();
      loadListeners();
    });
    document.getElementById('nc-tcp-go').addEventListener('click', runTcp);
    document.getElementById('nc-ports-go').addEventListener('click', runPorts);

    loadOptions();
    loadOverview();
    loadListeners();
  }

  async function loadOptions() {
    try {
      const o = await Api.get('/api/network-check/options');
      const el = document.getElementById('nc-policy');
      if (!el) return;
      el.textContent = o.allowPublicTargets
        ? 'Public IPs allowed (ALAPAAP_NETWORK_ALLOW_PUBLIC=1). Link-local 169.254/16 still blocked.'
        : 'Probes limited to localhost, private LAN, and IPv6 ULA/link-local. Set ALAPAAP_NETWORK_ALLOW_PUBLIC=1 to probe public hosts.';
    } catch { /* ignore */ }
  }

  async function loadOverview() {
    const el = document.getElementById('nc-overview');
    if (!el) return;
    try {
      const data = await Api.get('/api/network-check/overview');
      const lines = [`hostname: ${esc(data.hostname || '--')}`, ''];
      for (const i of data.interfaces || []) {
        const intl = i.internal ? ' (internal)' : '';
        lines.push(
          `${esc(i.name)}  ${esc(i.family)}  ${esc(i.address)}${intl}` +
          (i.mac ? `  mac ${esc(i.mac)}` : '')
        );
      }
      el.innerHTML = lines.join('\n') || '<span class="text-dim">no interfaces</span>';
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function renderListeners(listeners) {
    const el = document.getElementById('nc-listeners');
    if (!el) return;
    if (!listeners || listeners.length === 0) {
      el.innerHTML = '<span class="text-dim">no listening sockets (or /proc unavailable)</span>';
      return;
    }
    const header = '<tr><th>bind</th><th>port</th><th>family</th><th>service (guess)</th></tr>';
    const rows = listeners.map((l) =>
      `<tr>
        <td class="text-dim">${esc(String(l.bind))}</td>
        <td>${l.port}</td>
        <td class="text-dim">${esc(l.family)}</td>
        <td>${l.service ? `<span class="text-ok">${esc(l.service)}</span>` : '<span class="text-dim">--</span>'}</td>
      </tr>`
    ).join('');
    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;
  }

  async function loadListeners() {
    const el = document.getElementById('nc-listeners');
    if (!el) return;
    try {
      const data = await Api.get('/api/network-check/listeners');
      renderListeners(data.listeners);
    } catch (err) {
      el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function runTcp() {
    const host = document.getElementById('nc-host')?.value?.trim();
    const port = parseInt(document.getElementById('nc-port')?.value, 10);
    const out = document.getElementById('nc-tcp-out');
    if (!host || Number.isNaN(port)) {
      App.toast('host and port required', 'error');
      return;
    }
    out.innerHTML = '<span class="text-dim">checking...</span>';
    try {
      const r = await Api.post('/api/network-check/tcp', { host, port });
      if (r.ok) {
        out.innerHTML =
          `<span class="text-ok">OPEN</span>  ${esc(r.host)}:${r.port}` +
          `  via ${esc(r.remoteIp)}  ${r.latencyMs}ms` +
          (r.service ? `  <span class="text-dim">(${esc(r.service)})</span>` : '');
      } else {
        out.innerHTML =
          `<span class="text-err">CLOSED</span>  ${esc(r.host)}:${r.port}` +
          `  <span class="text-dim">${esc(r.error || 'failed')}  tried ${r.tried || 0}</span>` +
          (r.service ? `  <span class="text-dim">(${esc(r.service)})</span>` : '');
      }
    } catch (err) {
      out.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function runPorts() {
    const host = document.getElementById('nc-host-batch')?.value?.trim();
    const raw = document.getElementById('nc-ports')?.value || '';
    const out = document.getElementById('nc-ports-out');
    if (!host) {
      App.toast('host required', 'error');
      return;
    }
    const ports = raw.split(/[\s,]+/).map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n));
    if (ports.length === 0) {
      App.toast('enter at least one port', 'error');
      return;
    }
    out.innerHTML = '<span class="text-dim">scanning...</span>';
    try {
      const data = await Api.post('/api/network-check/ports', { host, ports });
      const header = '<tr><th>port</th><th>state</th><th>remote IP</th><th>ms</th><th>service</th></tr>';
      const rows = (data.results || []).map((r) => {
        const st = r.ok
          ? '<span class="text-ok">OPEN</span>'
          : '<span class="text-err">CLOSED</span>';
        return `<tr>
          <td>${r.port}</td>
          <td>${st}</td>
          <td class="text-dim">${r.ok ? esc(r.remoteIp) : esc(r.error || '--')}</td>
          <td class="text-dim">${r.ok ? r.latencyMs : '--'}</td>
          <td class="text-dim">${r.service ? esc(r.service) : '--'}</td>
        </tr>`;
      }).join('');
      out.innerHTML = `<table class="table-console">${header}${rows}</table>`;
    } catch (err) {
      out.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function destroy() {}

  return { render, destroy };
})();
