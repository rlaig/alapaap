'use strict';

const { getMetrics } = require('./clickhouse');
const { broadcast } = require('../../core/websocket');
const maintenance = require('./maintenance');

let interval = null;

module.exports = {
  name: 'clickhouse-manager',
  version: '1.0.0',
  description: 'ClickHouse monitoring and query management',

  init({ config }) {
    const ms = config.ws.clickhouseInterval || 5000;
    interval = setInterval(async () => {
      try {
        const metrics = await getMetrics();
        broadcast('clickhouse:metrics', metrics);
      } catch (err) {
        console.error('[clickhouse-manager] Broadcast error:', err.message);
      }
    }, ms);

    maintenance.start();
  },

  routes: require('./routes'),
  wsChannels: ['clickhouse:metrics'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
    maintenance.stop();
  },
};
