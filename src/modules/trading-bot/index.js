'use strict';

const { getStatus, getServiceStatus, getActiveProfile } = require('./trading-bot');
const { broadcast } = require('../../core/websocket');

let interval = null;

module.exports = {
  name: 'trading-bot',
  version: '1.0.0',
  description: 'Trading bot service management and monitoring',

  init({ config }) {
    const ms = config.ws.tradingBotInterval || 5000;
    interval = setInterval(async () => {
      try {
        const [status, service] = await Promise.all([
          getStatus(),
          getServiceStatus(),
        ]);
        const activeProfile = getActiveProfile();
        broadcast('trading-bot:status', {
          bot: status,
          activeProfile,
          service: service ? {
            ActiveState: service.ActiveState,
            SubState: service.SubState,
            StateChangeTimestamp: service.StateChangeTimestamp,
            MemoryCurrent: service.MemoryCurrent,
            MainPID: service.MainPID,
          } : null,
        });
      } catch (err) {
        console.error('[trading-bot] Broadcast error:', err.message);
      }
    }, ms);
  },

  routes: require('./routes'),
  wsChannels: ['trading-bot:status'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
  },
};
