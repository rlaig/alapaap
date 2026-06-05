'use strict';

const jobs = require('./job-manager');

module.exports = {
  name: 'backtest',
  version: '1.0.0',
  description: 'Backtesting engine UI — run, review, and compare strategy backtests',

  init() {
    jobs.startBroadcastLoop();
  },

  routes: require('./routes'),
  wsChannels: ['backtest:jobs'],

  destroy() {
    jobs.cancelAllRunning();
    jobs.stopBroadcastLoop();
  },
};
