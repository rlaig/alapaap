'use strict';

const botStatus = require('./trading-bot');
const { broadcast } = require('../../core/websocket');
const jobs = require('./backtest/job-manager');

let interval = null;

module.exports = {
  name: 'trading-bot',
  version: '2.0.0',
  description: 'Trading bot monitoring, control, and backtesting',

  init({ app, config }) {
    // Mount backtest routes at /api/backtest (the loader auto-mounts ./routes at /api/trading-bot)
    app.use('/api/backtest', require('./backtest/routes'));

    // Start trading bot status broadcast
    const ms = config.ws.tradingBotInterval || 5000;
    interval = setInterval(async () => {
      try {
        const [status, service] = await Promise.all([
          botStatus.getStatus(),
          botStatus.getServiceStatus(),
        ]);
        const activeProfile = botStatus.getActiveProfile();
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

    // Start backtest job broadcast loop
    jobs.startBroadcastLoop();
  },

  routes: require('./routes'),
  wsChannels: ['trading-bot:status', 'backtest:jobs'],

  destroy() {
    if (interval) { clearInterval(interval); interval = null; }
    jobs.cancelAllRunning();
    jobs.stopBroadcastLoop();
  },
};
