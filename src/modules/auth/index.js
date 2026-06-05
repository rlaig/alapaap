'use strict';

const { runFirstTimeSetup } = require('./setup');

module.exports = {
  name: 'auth',
  version: '1.0.0',
  description: 'Authentication and user management',

  init() {
    runFirstTimeSetup();
  },

  routes: require('./routes'),
  wsChannels: [],

  destroy() {},
};
