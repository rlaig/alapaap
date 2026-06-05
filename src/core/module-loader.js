'use strict';

const fs = require('fs');
const path = require('path');
const { registerChannel } = require('./websocket');

const loaded = new Map();

function loadModules(app, wss, config) {
  const modulesDir = path.join(__dirname, '..', 'modules');
  const enabled = config.modules.enabled;

  for (const name of enabled) {
    const modPath = path.join(modulesDir, name);
    if (!fs.existsSync(path.join(modPath, 'index.js'))) {
      console.warn(`[modules] Module "${name}" not found, skipping`);
      continue;
    }

    try {
      const mod = require(path.join(modPath, 'index.js'));

      if (!mod.name) {
        console.warn(`[modules] Module at "${name}" has no name, skipping`);
        continue;
      }

      if (mod.wsChannels) {
        for (const ch of mod.wsChannels) {
          registerChannel(ch);
        }
      }

      if (mod.routes) {
        const prefix = `/api/${mod.name}`;
        app.use(prefix, mod.routes);
        console.log(`[modules] Mounted routes: ${prefix}`);
      }

      if (mod.init) {
        mod.init({ app, wss, config });
      }

      loaded.set(mod.name, mod);
      console.log(`[modules] Loaded: ${mod.name} v${mod.version || '0.0.0'}`);
    } catch (err) {
      console.error(`[modules] Failed to load "${name}":`, err.message);
    }
  }
}

async function destroyAll() {
  for (const [name, mod] of loaded) {
    if (mod.destroy) {
      try {
        await mod.destroy();
      } catch (err) {
        console.error(`[modules] Error destroying "${name}":`, err.message);
      }
    }
  }
  loaded.clear();
}

function getModule(name) {
  return loaded.get(name);
}

module.exports = { loadModules, destroyAll, getModule };
