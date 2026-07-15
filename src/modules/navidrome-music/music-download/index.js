'use strict';

const { broadcast } = require('../../../core/websocket');
const manager = require('./download-manager');

module.exports = {
  name: 'music-download',
  version: '1.0.0',
  description: 'YouTube music download with automatic metadata tagging',

  init({ config }) {
    const cfg = config.musicDownload;
    if (!cfg) {
      console.warn('[music-download] No config found, using defaults');
      return;
    }

    manager.configure(cfg);

    // Wire broadcast into routes
    const routes = require('./routes');
    routes.setBroadcast(broadcast);

    const dlPath = cfg.downloadPath || '/path/navidrome/music/ytdl';
    const { existsSync } = require('fs');
    if (!existsSync(dlPath)) {
      console.warn(`[music-download] Download path does not exist: ${dlPath}`);
    }

    console.log(`[music-download] Download path: ${dlPath}`);
  },

  routes: require('./routes'),
  wsChannels: ['music-download:progress'],

  destroy() {
    manager.destroy();
  },
};
