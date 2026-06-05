'use strict';

const { collectAll } = require('./collectors');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'system-monitor',
  version: '1.0.0',
  description: 'System resource monitoring',

  init({ config }) {
    const ms = config.ws.systemMetricsInterval || 2000;
    interval = setInterval(async () => {
      try {
        const data = await collectAll();
        broadcast('system:metrics', data);
      } catch (err) {
        console.error('[system-monitor] Collection error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['system:metrics'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
