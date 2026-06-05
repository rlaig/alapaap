'use strict';

const DashboardComponent = (() => {
  let metricsHandler = null;

  function render(container) {
    container.innerHTML = `
      <div class="grid grid-2">
        <div class="panel">
          <div class="panel-header">&gt;_ system overview</div>
          <div class="panel-body-pre" id="dash-system">
            <span class="text-dim">waiting for data...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ memory</div>
          <div class="panel-body-pre" id="dash-memory">
            <span class="text-dim">waiting for data...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ disk usage</div>
          <div class="panel-body-pre" id="dash-disk">
            <span class="text-dim">waiting for data...</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">&gt;_ network</div>
          <div class="panel-body-pre" id="dash-network">
            <span class="text-dim">waiting for data...</span>
          </div>
        </div>
      </div>`;

    metricsHandler = (data) => updateDashboard(data);
    WsClient.subscribe('system:metrics', metricsHandler);
  }

  function updateDashboard(data) {
    if (!data) return;

    const sysEl = document.getElementById('dash-system');
    if (sysEl && data.cpu !== undefined) {
      sysEl.innerHTML =
        `hostname : ${data.hostname || '--'}\n` +
        `uptime   : ${formatUptime(data.uptime)}\n` +
        `load avg : ${(data.loadavg || []).map(l => l.toFixed(2)).join(' ')}\n` +
        `cpu      : ${gauge(data.cpu, 20)} ${data.cpu.toFixed(1)}%`;
    }

    const memEl = document.getElementById('dash-memory');
    if (memEl && data.memory) {
      const m = data.memory;
      const pct = m.total ? ((m.used / m.total) * 100) : 0;
      memEl.innerHTML =
        `total    : ${fmtBytes(m.total)}\n` +
        `used     : ${fmtBytes(m.used)}\n` +
        `free     : ${fmtBytes(m.free)}\n` +
        `usage    : ${gauge(pct, 20)} ${pct.toFixed(1)}%`;
    }

    const diskEl = document.getElementById('dash-disk');
    if (diskEl && data.disks) {
      diskEl.innerHTML = data.disks.map(d => {
        const pct = parseFloat(d.percent) || 0;
        return `${d.mount.padEnd(12)} ${gauge(pct, 15)} ${String(pct.toFixed(0)).padStart(3)}% of ${d.size}`;
      }).join('\n') || 'no disks';
    }

    const netEl = document.getElementById('dash-network');
    if (netEl && data.network) {
      netEl.innerHTML = data.network.map(n =>
        `${n.iface.padEnd(10)} rx: ${fmtBytes(n.rxBytes).padStart(10)}  tx: ${fmtBytes(n.txBytes).padStart(10)}`
      ).join('\n') || 'no interfaces';
    }
  }

  function gauge(pct, width) {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const color = pct > 90 ? 'text-err' : pct > 70 ? 'text-warn' : 'text-ok';
    return `<span class="${color}">[${'\u2588'.repeat(filled)}${'\u2591'.repeat(empty)}]</span>`;
  }

  function fmtBytes(b) {
    if (b == null) return '--';
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + units[i];
  }

  function formatUptime(s) {
    if (!s) return '--';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  function destroy() {
    if (metricsHandler) {
      WsClient.unsubscribe('system:metrics', metricsHandler);
      metricsHandler = null;
    }
  }

  return { render, destroy };
})();
