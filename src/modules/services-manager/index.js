'use strict';

const { listServices } = require('./service');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'services-manager',
  version: '1.0.0',
  description: 'Systemd service management',

  init({ config }) {
    const ms = config.ws.servicesInterval || 5000;
    interval = setInterval(async () => {
      try {
        const services = await listServices();
        broadcast('services:status', services);
      } catch (err) {
        console.error('[services-manager] Broadcast error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['services:status'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
