'use strict';

const { listInstances } = require('./service');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'nanobot',
  version: '1.0.0',
  description: 'Monitor nanobot instances and manage cron jobs',

  init({ config }) {
    const ms = config.ws.nanobotServiceInterval || 5000;
    interval = setInterval(async () => {
      try {
        const instances = await listInstances();
        broadcast('nanobot-service:status', { instances });
      } catch (err) {
        console.error('[nanobot] Broadcast error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['nanobot-service:status'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
