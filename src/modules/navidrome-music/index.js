'use strict';

const fs = require('fs');
const music = require('./music');
const musicbrainz = require('./musicbrainz');

module.exports = {
  name: 'navidrome-music',
  version: '1.0.0',
  description: 'Navidrome music file and tag manager',

  init({ config }) {
    const cfg = config.navidromeMusic;
    if (!cfg) {
      console.warn('[navidrome-music] No config found, using defaults');
      return;
    }

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
  },

  routes: require('./routes'),
  wsChannels: ['navidrome-music:scan-progress'],

  destroy() {},
};
