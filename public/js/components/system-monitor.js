'use strict';

const SystemMonitorComponent = (() => {
  let metricsHandler = null;

  function render(container) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">&gt;_ system metrics</div>
        <div class="panel-body-pre" id="sysmon-metrics">
          <span class="text-dim">waiting for data...</span>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">&gt;_ processes (top by cpu)</div>
        <div class="panel-body-pre scroll-x" id="sysmon-procs">
          <span class="text-dim">waiting for data...</span>
        </div>
      </div>`;

    metricsHandler = (data) => update(data);
    WsClient.subscribe('system:metrics', metricsHandler);
  }

  function update(data) {
    if (!data) return;

    const mel = document.getElementById('sysmon-metrics');
    if (mel) {
      const lines = [];
      if (data.cpu !== undefined) lines.push(`cpu usage  : ${mkGauge(data.cpu, 30)} ${data.cpu.toFixed(1)}%`);
      if (data.memory) {
        const pct = data.memory.total ? (data.memory.used / data.memory.total * 100) : 0;
        lines.push(`memory     : ${mkGauge(pct, 30)} ${pct.toFixed(1)}% (${fmtB(data.memory.used)}/${fmtB(data.memory.total)})`);
      }
      if (data.loadavg) lines.push(`load avg   : ${data.loadavg.map(l => l.toFixed(2)).join('  ')}`);
      if (data.uptime) lines.push(`uptime     : ${fmtUp(data.uptime)}`);
      if (data.disks) {
        lines.push('');
        lines.push('-- disks --');
        for (const d of data.disks) {
          const pct = parseFloat(d.percent) || 0;
          lines.push(`${d.mount.padEnd(14)} ${mkGauge(pct, 20)} ${String(pct.toFixed(0)).padStart(3)}%  ${d.used}/${d.size}`);
        }
      }
      if (data.network) {
        lines.push('');
        lines.push('-- network --');
        for (const n of data.network) {
          lines.push(`${n.iface.padEnd(12)} rx: ${fmtB(n.rxBytes).padStart(10)}  tx: ${fmtB(n.txBytes).padStart(10)}`);
        }
      }
      mel.innerHTML = lines.join('\n');
    }

    const pel = document.getElementById('sysmon-procs');
    if (pel && data.processes) {
      const header = 'PID'.padStart(7) + '  ' + 'CPU%'.padStart(6) + '  ' + 'MEM'.padStart(10) + '  ' + 'NAME';
      const rows = data.processes.map(p =>
        String(p.pid).padStart(7) + '  ' +
        p.cpu.toFixed(1).padStart(6) + '  ' +
        fmtB(p.rss).padStart(10) + '  ' +
        p.name
      );
      pel.innerHTML = `<span class="text-muted">${header}</span>\n${rows.join('\n')}`;
    }
  }

  function mkGauge(pct, w) {
    const f = Math.round((pct / 100) * w);
    const e = w - f;
    const c = pct > 90 ? 'text-err' : pct > 70 ? 'text-warn' : 'text-ok';
    return `<span class="${c}">[${'\u2588'.repeat(f)}${'\u2591'.repeat(e)}]</span>`;
  }

  function fmtB(b) {
    if (b == null) return '--';
    const u = ['B','K','M','G','T'];
    let i = 0, v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + u[i];
  }

  function fmtUp(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
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
