'use strict';

const { listContainers } = require('./docker');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'docker-manager',
  version: '1.0.0',
  description: 'Docker container and image management',

  init({ config }) {
    const ms = config.ws.dockerInterval || 5000;
    interval = setInterval(async () => {
      try {
        const containers = await listContainers(true);
        broadcast('docker:status', { containers });
      } catch (err) {
        console.error('[docker-manager] Broadcast error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['docker:status', 'docker:logs'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
