'use strict';

const { getServiceStatuses } = require('./service');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'receipt-scanner-logs',
  version: '1.0.0',
  description: 'Receipt scanner service logs and monitoring',

  init({ config }) {
    const ms = config.ws.receiptScannerLogsInterval || 5000;
    interval = setInterval(async () => {
      try {
        const services = await getServiceStatuses();
        broadcast('receipt-scanner-logs:status', { services });
      } catch (err) {
        console.error('[receipt-scanner-logs] Broadcast error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['receipt-scanner-logs:status'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
