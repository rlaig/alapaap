'use strict';

const { getServiceStatuses } = require('./service');
const { broadcast } = require('../../core/websocket');
const { createLogStream } = require('../../core/log-stream');
const config = require('../../../config/default');

const SERVICES = config.receiptScannerLogs.services;
let statusInterval = null;
let logStream = null;

module.exports = {
  name: 'receipt-scanner-logs',
  version: '1.0.0',
  description: 'Receipt scanner service logs and monitoring',

  init({ config: cfg }) {
    // Status broadcast (existing)
    const ms = cfg.ws.receiptScannerLogsInterval || 5000;
    statusInterval = setInterval(async () => {
      try {
        const services = await getServiceStatuses();
        broadcast('receipt-scanner-logs:status', { services });
      } catch (err) {
        console.error('[receipt-scanner-logs] Broadcast error:', err.message);
      }
    }, ms);

    // Real-time log stream (new)
    logStream = createLogStream({
      channel: 'receipt-scanner-logs:logs',
      services: SERVICES,
      source: 'journalctl',
    });
    logStream.start();
  },

  routes: require('./routes'),
  wsChannels: ['receipt-scanner-logs:status', 'receipt-scanner-logs:logs', 'receipt-scanner-logs:deploy'],

  destroy() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    if (logStream) { logStream.stop(); logStream = null; }
  },
};
