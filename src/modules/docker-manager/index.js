'use strict';

const { listContainers, containerStats, compactStats } = require('./docker');
const { broadcast, registerMessageHandler } = require('../../core/websocket');
const exec = require('./exec-bridge');

let interval = null;

module.exports = {
  name: 'docker-manager',
  version: '2.0.0',
  description: 'Docker container, image, volume, network and system management',

  init({ config }) {
    const ms = config.ws.dockerInterval || 5000;

    // Interactive exec terminal — custom bidirectional WS message types.
    registerMessageHandler('exec:attach', (ws, m) => exec.attach(ws, m));
    registerMessageHandler('exec:input', (ws, m) => exec.input(m.execId, m.data));
    registerMessageHandler('exec:resize', (ws, m) => exec.resize(m.execId, m.cols, m.rows));
    registerMessageHandler('exec:detach', (ws, m) => exec.detach(m.execId));

    interval = setInterval(async () => {
      try {
        const containers = await listContainers(true);

        if (config.docker?.statsInList !== false) {
          // Best-effort parallel stats for running containers only.
          await Promise.all((containers || []).map(async (c) => {
            const state = (c.State || '').toLowerCase();
            if (state !== 'running') return;
            try {
              const id = c.Id;
              const stats = await containerStats(id);
              c.stats = compactStats(stats);
            } catch { /* omit */ }
          }));
        }

        broadcast('docker:status', { containers });
      } catch (err) {
        console.error('[docker-manager] Broadcast error:', err.message);
      }
    }, ms);
    if (interval.unref) interval.unref();
  },

  routes: require('./routes'),
  wsChannels: ['docker:status', 'docker:image-pull', 'docker:logs'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
    exec.destroyAll();
  },
};
