'use strict';

// GlobalPlayer — Spotify-style persistent audio player owned by the app shell.
//
// Survives route changes. Other components talk to it through App.Player:
//   App.Player.enqueue(tracks)   // seed autoplay queue
//   App.Player.play(track)       // play a track (uses current queue; creates one if missing)
//   App.Player.pause() / resume() / toggle()
//   App.Player.next() / prev()
//   App.Player.currentTrack()    // -> { name, path, title, artist } or null
//   App.Player.on('trackchange', cb) / on('play', cb) / on('pause', cb) / on('ended', cb)
//
// Autoplay: when a track ends, advances to the next item in the queue and loops
// back to the start when it reaches the end. If the queue is empty after a
// track ends, audio just stops.

const GlobalPlayer = (() => {
  const API = '/api/navidrome-music';
  const VOLUME_KEY = 'alapaap-player-volume';

  let queue = [];        // [{ name, path, title, artist }, ...]
  let index = -1;
  let audio = null;
  let bar = null;
  let initialized = false;
  const listeners = { trackchange: [], play: [], pause: [], ended: [] };

  function init() {
    if (initialized) return;
    bar = document.getElementById('global-player');
    if (!bar) return;
    initialized = true;

    const saved = parseFloat(localStorage.getItem(VOLUME_KEY));
    const initialVolume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;

    bar.innerHTML = `
      <div class="nm-player-cover">
        <img class="nm-player-thumb" id="gp-cover" alt="" />
        <div class="nm-player-thumb-placeholder" id="gp-cover-placeholder">🎵</div>
      </div>
      <button class="btn-console btn-sm nm-player-btn" id="gp-prev" title="previous" aria-label="Previous">&#9198;</button>
      <button class="btn-console btn-sm nm-player-btn" id="gp-play" title="play/pause" aria-label="Play or pause">&#9654;</button>
      <button class="btn-console btn-sm nm-player-btn" id="gp-next" title="next" aria-label="Next">&#9197;</button>
      <div class="nm-player-info">
        <span class="nm-player-title" id="gp-title">--</span>
        <span class="nm-player-artist" id="gp-artist"></span>
      </div>
      <div class="nm-player-controls">
        <span class="nm-player-time" id="gp-time">0:00</span>
        <input type="range" class="nm-player-range" id="gp-seek" min="0" max="100" value="0" step="0.1" />
        <span class="nm-player-time" id="gp-duration">0:00</span>
        <input type="range" class="nm-player-volume" id="gp-vol" min="0" max="1" value="${initialVolume}" step="0.05" />
      </div>`;

    audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = initialVolume;

    audio.addEventListener('play', () => { syncPlayButton(); emit('play'); });
    audio.addEventListener('pause', () => { syncPlayButton(); emit('pause'); });
    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('loadedmetadata', syncDuration);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => {
      if (typeof App !== 'undefined' && App.toast) {
        App.toast('Playback error', 'error');
      }
    });

    document.getElementById('gp-play').addEventListener('click', toggle);
    document.getElementById('gp-prev').addEventListener('click', prev);
    document.getElementById('gp-next').addEventListener('click', next);

    const seek = document.getElementById('gp-seek');
    seek.addEventListener('input', () => {
      if (audio && audio.duration) {
        audio.currentTime = (seek.value / 100) * audio.duration;
      }
    });

    const vol = document.getElementById('gp-vol');
    vol.addEventListener('input', () => {
      const v = parseFloat(vol.value);
      if (audio) audio.volume = v;
      try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* ignore */ }
    });
  }

  function show() {
    if (!bar) return;
    bar.classList.remove('hidden');
    document.body.classList.add('player-active');
  }
  function hide() {
    if (!bar) return;
    bar.classList.add('hidden');
    document.body.classList.remove('player-active');
  }

  function emit(event) {
    const list = listeners[event] || [];
    for (const cb of list) {
      try { cb(currentTrack()); } catch (e) { console.error('Player listener error', e); }
    }
  }

  function on(event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
  }
  function off(event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((c) => c !== cb);
  }

  function currentTrack() {
    return index >= 0 && index < queue.length ? queue[index] : null;
  }

  function enqueue(tracks) {
    queue = Array.isArray(tracks) ? tracks.slice() : [];
    // Keep current index if the same track is still in the new queue; else reset.
    const cur = currentTrack();
    if (cur) {
      const newIdx = queue.findIndex((t) => t.path === cur.path);
      index = newIdx >= 0 ? newIdx : -1;
    } else {
      index = -1;
    }
  }

  function play(track, opts = {}) {
    init();
    if (!bar || !audio) return;

    // If track is in the current queue, jump to it. Otherwise treat it as a
    // single-track queue (autoplay-next will have nothing to follow).
    if (track) {
      const idx = queue.findIndex((t) => t.path === track.path);
      if (idx >= 0) {
        index = idx;
      } else {
        queue = [track];
        index = 0;
      }
    } else if (index < 0 && queue.length > 0) {
      index = 0;
    } else if (index < 0) {
      return; // nothing to play
    }

    const t = currentTrack();
    if (!t) return;

    show();
    renderInfo();

    const streamUrl = `${API}/stream?path=${encodeURIComponent(t.path)}`;
    if (audio.src !== streamUrl) {
      audio.src = streamUrl;
    }
    audio.play().catch(() => {
      // Autoplay may be blocked; the user can click play to retry.
    });

    emit('trackchange');
  }

  function pause() { if (audio) audio.pause(); }
  function resume() { if (audio) audio.play().catch(() => {}); }
  function toggle() {
    if (!audio) return;
    if (audio.paused) resume(); else pause();
  }

  function next() {
    if (queue.length === 0) return;
    if (index < queue.length - 1) {
      index += 1;
    } else {
      index = 0; // loop
    }
    play(null);
  }

  function prev() {
    if (queue.length === 0) return;
    if (index > 0) {
      index -= 1;
    } else {
      index = queue.length - 1; // loop backwards
    }
    play(null);
  }

  // Called when a track is deleted while it is the one playing: skip past it.
  function advancePast(path) {
    const i = queue.findIndex((t) => t.path === path);
    if (i < 0) return;
    if (i < index) {
      // Deleted track is behind us — adjust index, then remove.
      index -= 1;
      queue.splice(i, 1);
    } else if (i === index) {
      // Deleted track is the one playing — remove first, then advance.
      queue.splice(i, 1);
      if (queue.length === 0) {
        index = -1;
        pause();
        hide();
      } else {
        if (index >= queue.length) index = 0; // wrapped past end
        play(null);
      }
    } else {
      // Deleted track is ahead of us — just remove.
      queue.splice(i, 1);
    }
  }

  function renderInfo() {
    const t = currentTrack();
    const titleEl = document.getElementById('gp-title');
    const artistEl = document.getElementById('gp-artist');
    const coverEl = document.getElementById('gp-cover');
    const placeholderEl = document.getElementById('gp-cover-placeholder');

    if (!t) {
      if (titleEl) titleEl.textContent = '--';
      if (artistEl) artistEl.textContent = '';
      if (coverEl) coverEl.style.display = 'none';
      if (placeholderEl) placeholderEl.style.display = 'block';
      return;
    }

    if (titleEl) titleEl.textContent = t.title || t.name;
    if (artistEl) artistEl.textContent = t.artist || '';

    // Update cover art
    const coverUrl = `${API}/cover-art?path=${encodeURIComponent(t.path)}`;
    if (coverEl) {
      coverEl.src = coverUrl;
      coverEl.style.display = 'block';
      coverEl.onerror = () => {
        coverEl.style.display = 'none';
        if (placeholderEl) placeholderEl.style.display = 'block';
      };
      coverEl.onload = () => {
        if (placeholderEl) placeholderEl.style.display = 'none';
      };
    }
  }

  function syncPlayButton() {
    const btn = document.getElementById('gp-play');
    if (!btn || !audio) return;
    btn.innerHTML = audio.paused ? '&#9654;' : '❚❚';
  }

  function syncTime() {
    const seek = document.getElementById('gp-seek');
    const timeEl = document.getElementById('gp-time');
    if (!audio || !seek || !timeEl) return;
    if (audio.duration) {
      seek.value = (audio.currentTime / audio.duration) * 100;
    }
    timeEl.textContent = fmtDuration(audio.currentTime * 1000);
  }

  function syncDuration() {
    const durEl = document.getElementById('gp-duration');
    if (durEl && audio) durEl.textContent = fmtDuration(audio.duration * 1000);
  }

  function onEnded() {
    emit('ended');
    if (queue.length === 0) return;
    // Auto-advance. If we're already at the last track, loop to start.
    if (index >= queue.length - 1) index = -1;
    next();
  }

  function destroy() {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    queue = [];
    index = -1;
    for (const k of Object.keys(listeners)) listeners[k] = [];
    hide();
  }

  function fmtDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  return {
    init,
    destroy,
    enqueue,
    play,
    pause,
    resume,
    toggle,
    next,
    prev,
    advancePast,
    currentTrack,
    on,
    off,
  };
})();
