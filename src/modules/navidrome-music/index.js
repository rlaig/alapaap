'use strict';

const fs = require('fs');
const music = require('./music');
const musicbrainz = require('./musicbrainz');
const musicDownload = require('./music-download');

module.exports = {
  name: 'navidrome-music',
  version: '1.0.0',
  description: 'Navidrome music file and tag manager',

  init({ app, wss, config }) {
    const cfg = config.navidromeMusic;
    if (cfg) {
      music.configure(cfg);
      musicbrainz.configure(cfg);

      if (!fs.existsSync(cfg.musicPath)) {
        console.warn(`[navidrome-music] Music path does not exist: ${cfg.musicPath}`);
      }

      try {
        fs.accessSync(cfg.toneBin, fs.constants.X_OK);
      } catch {
        console.warn(`[navidrome-music] tone binary not executable: ${cfg.toneBin}`);
      }

      console.log(`[navidrome-music] Music path: ${cfg.musicPath}`);
    } else {
      console.warn('[navidrome-music] No config found, using defaults');
    }

    // Music download sub-module (merged from the former standalone module).
    // Keep the historical /api/music-download prefix so existing endpoints
    // and the WebSocket channel name are unchanged.
    if (app && musicDownload.routes) {
      app.use('/api/music-download', musicDownload.routes);
      console.log('[modules] Mounted routes: /api/music-download');
    }
    if (musicDownload.init) musicDownload.init({ app, wss, config });
  },

  routes: require('./routes'),
  wsChannels: ['navidrome-music:scan-progress', 'music-download:progress'],

  destroy() {
    if (musicDownload.destroy) musicDownload.destroy();
  },
};
