'use strict';

const NavidromeMusicComponent = (() => {
  const API = '/api/navidrome-music';
  const DL_API = '/api/music-download';
  let currentPath = '';
  let browseData = null;
  let batchMeta = {};
  let selectedFiles = new Set();
  let filterText = '';
  let statsData = null;
  let statsVisible = false;
  let drawerFile = null;
  let drawerMeta = null;
  let editing = false;
  let editTags = {};
  let confirmTarget = null;
  let syncState = null;
  let syncData = null;
  let syncSearch = { title: '', artist: '' };
  let currentPlayingFile = null;
  let playerFilePath = null;

  // Download tab state
  let activeTab = 'library';
  let activeDownloads = new Map();
  let dlWsHandler = null;
  let searchPreviewState = null;

  // ── Tabs ────────────────────────────────────────────────

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#nm-main-tabs .bt-tab').forEach((t) => {
      t.classList.toggle('bt-tab-active', t.dataset.tab === tab);
    });
    document.querySelectorAll('#nm-tab-library, #nm-tab-download').forEach((el) => {
      el.classList.toggle('active', el.id === `nm-tab-${tab}`);
    });
  }

  // ── Download tab ────────────────────────────────────────

  async function doDownload() {
    const input = document.getElementById('nm-dl-input');
    const query = (input.value || '').trim();
    if (!query) return;

    // Client-side URL detection (same regex as backend)
    const urlPattern = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;
    const isUrl = urlPattern.test(query);

    if (isUrl) {
      // Direct URL download - existing behavior
      await startDownload(query);
    } else {
      // Search query - show preview first
      await showSearchPreview(query);
    }
  }

  async function showSearchPreview(query) {
    const resultEl = document.getElementById('nm-search-result');
    resultEl.innerHTML = '<span class="text-dim">searching...</span>';

    try {
      const result = await Api.get(`${DL_API}/search?query=${encodeURIComponent(query)}`);

      if (!result || !result.data || !result.data.title) {
        resultEl.innerHTML = `<span class="text-err">No results found for: ${esc(query)}</span>`;
        return;
      }

      searchPreviewState = { query, result: result.data };
      renderSearchPreview(resultEl, result.data, query);
    } catch (err) {
      resultEl.innerHTML = `<span class="text-err">Search error: ${esc(err.message)}</span>`;
    }
  }

  function renderSearchPreview(container, data, query) {
    const {
      title = 'Unknown',
      artist = 'Unknown',
      duration = 0,
      thumbnail = null,
      url = null
    } = data;

    const durationText = formatDuration(duration);
    const thumbnailHtml = thumbnail
      ? `<img class="nm-preview-thumb" src="${thumbnail}" alt="thumbnail" />`
      : `<div class="nm-preview-thumb nm-preview-thumb-placeholder">[no thumbnail]</div>`;

    container.innerHTML = `
      <div class="nm-search-preview">
        <div class="nm-preview-heading">SEARCH RESULT FOR "${esc(query)}"</div>
        <div class="nm-preview-card">
          ${thumbnailHtml}
          <div class="nm-preview-info">
            <div class="nm-preview-title">${esc(title)}</div>
            <div class="nm-preview-artist">${esc(artist)}</div>
            <div class="nm-preview-meta">${durationText}</div>
          </div>
        </div>
        <div class="nm-preview-actions">
          <button class="btn-console btn-sm btn-ok" id="nm-preview-confirm">download this track</button>
          <button class="btn-console btn-sm" id="nm-preview-cancel">cancel</button>
        </div>
      </div>
    `;

    // Wire up buttons
    document.getElementById('nm-preview-confirm').addEventListener('click', () => {
      confirmPreviewDownload();
    });

    document.getElementById('nm-preview-cancel').addEventListener('click', () => {
      clearPreview();
    });
  }

  function confirmPreviewDownload() {
    if (!searchPreviewState) return;

    const { query } = searchPreviewState;
    clearPreview();
    startDownload(query);
  }

  function clearPreview() {
    searchPreviewState = null;
    document.getElementById('nm-search-result').innerHTML = '';
  }

  async function startDownload(query) {
    const dlBtn = document.getElementById('nm-dl-btn');
    const resultEl = document.getElementById('nm-search-result');

    dlBtn.disabled = true;
    dlBtn.textContent = 'starting...';
    resultEl.innerHTML = '';

    try {
      const res = await Api.post(`${DL_API}/download`, { query });
      if (res && res.downloadId) {
        document.getElementById('nm-dl-input').value = '';
      } else if (res && res.error) {
        resultEl.innerHTML = `<span class="text-err">${esc(res.error)}</span>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="text-err">${esc(err.message)}</span>`;
    } finally {
      dlBtn.textContent = 'download';
      dlBtn.disabled = false;
    }
  }

  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  async function pollActive() {
    try {
      const res = await Api.get(`${DL_API}/active`);
      if (Array.isArray(res)) {
        for (const d of res) {
          if (d.status !== 'completed' && d.status !== 'failed' && d.status !== 'cancelled') {
            activeDownloads.set(d.id, d);
          }
        }
        renderActiveDownloads();
      }
    } catch { /* silent */ }
  }

  function renderActiveDownloads() {
    const el = document.getElementById('nm-active-downloads');
    if (!el) return;

    for (const [id, d] of activeDownloads) {
      const isDone = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled';
      const hasData = d.data && d.status === 'completed';
      const stageDone = d.stage === 'completed' && d.percent >= 100;
      if ((isDone && !hasData) || stageDone) {
        if (!d._doneAt) d._doneAt = Date.now();
        if (Date.now() - d._doneAt > 5000) activeDownloads.delete(id);
      }
    }

    if (activeDownloads.size === 0) {
      el.innerHTML = '';
      return;
    }

    let html = '';
    for (const [id, d] of activeDownloads) {
      const title = d.title || d.data?.title || d.query || '...';
      const stage = d.stage || d.status || 'starting';
      const percent = Math.min(d.percent || 0, 100);
      const isError = d.status === 'failed' || d.error;
      const isComplete = d.status === 'completed' || d.stage === 'completed';

      html += `
        <div class="md-dl-item${isError ? ' md-dl-error' : ''}${isComplete ? ' md-dl-done' : ''}">
          <div class="md-dl-title">${esc(title)}</div>
          <div class="md-dl-bar-wrap">
            <div class="md-dl-bar" style="width:${percent}%"></div>
            <span class="md-dl-percent">${isComplete ? 'done' : isError ? 'failed' : `${stage} ${percent}%`}</span>
          </div>
          ${d.error ? `<div class="md-dl-error-text">${esc(d.error)}</div>` : ''}
          ${d.data?.title ? (d.data.status === 'already_exists'
            ? `<div class="md-dl-done-text">&#9432; Already in library: ${esc(d.data.title)} - ${esc(d.data.artist)}</div>`
            : `<div class="md-dl-done-text">&#10003; Downloaded: ${esc(d.data.title)} - ${esc(d.data.artist)}</div>`) : ''}
        </div>`;
    }
    el.innerHTML = html;
  }

  function render(container) {
    container.innerHTML = `
      <div class="bt-tabs" id="nm-main-tabs">
        <button type="button" class="bt-tab bt-tab-active" data-tab="library">music library</button>
        <button type="button" class="bt-tab" data-tab="download">music download</button>
      </div>

      <div id="nm-tab-library" class="bt-tab-content active">
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span><span class="panel-collapse-icon">&#9660;</span><span class="panel-header-title">&gt;_ navidrome music</span></span>
            <div class="flex gap-8 items-center">
              <input type="text" class="form-input nm-filter-input" id="nm-filter" placeholder="filter..." />
              <button class="btn-console btn-sm" id="nm-stats-btn">stats</button>
              <button class="btn-console btn-sm" id="nm-refresh">refresh</button>
            </div>
          </div>
          <div class="panel-body">
            <div id="nm-breadcrumb" class="nm-breadcrumb"></div>
            <div id="nm-folders" class="nm-folder-bar"></div>
            <div id="nm-list" style="overflow-x:auto"><span class="text-dim">loading...</span></div>
          </div>
        </div>
        <div class="panel hidden" id="nm-stats-panel">
          <div class="panel-header"><span class="panel-collapse-icon">&#9660;</span><span class="panel-header-title">&gt;_ library stats</span></div>
          <div class="panel-body" id="nm-stats-body"><span class="text-dim">loading...</span></div>
        </div>
        <div id="nm-batch-bar" class="nm-batch-bar hidden">
          <span id="nm-batch-count" class="text-dim"></span>
          <input type="text" class="form-input nm-batch-input" id="nm-batch-artist" placeholder="artist" />
          <input type="text" class="form-input nm-batch-input" id="nm-batch-album" placeholder="album" />
          <input type="text" class="form-input nm-batch-input" id="nm-batch-genre" placeholder="genre" />
          <button class="btn-console btn-sm btn-ok" id="nm-batch-apply">apply</button>
          <button class="btn-console btn-sm" id="nm-batch-clear">clear</button>
        </div>
        <div id="nm-overlay" class="nm-overlay hidden">
          <div id="nm-drawer" class="nm-drawer">
            <div class="panel-header flex justify-between items-center">
              <span>&gt;_ <span id="nm-drawer-title"></span></span>
              <button class="btn-console btn-sm" id="nm-drawer-close">close</button>
            </div>
            <div id="nm-drawer-body" class="panel-body" style="overflow-y:auto;flex:1"></div>
          </div>
        </div>
      </div>

      <div id="nm-tab-download" class="bt-tab-content">
        <div class="panel">
          <div class="panel-header flex justify-between items-center">
            <span><span class="panel-collapse-icon">&#9660;</span><span class="panel-header-title">&gt;_ music download</span></span>
            <span class="text-dim" style="font-size:11px">downloads land in /ytdl — browse &amp; play them in the music library tab</span>
          </div>
          <div class="panel-body">
            <div class="md-search-bar">
              <input type="text" class="form-input" id="nm-dl-input" placeholder="paste YouTube URL or search query..." style="flex:1" />
              <button class="btn-console btn-sm btn-ok" id="nm-dl-btn">download</button>
            </div>
            <div id="nm-search-result"></div>
            <div id="nm-active-downloads"></div>
          </div>
        </div>
      </div>`;

    document.getElementById('nm-refresh').addEventListener('click', () => loadFolder(currentPath));
    document.getElementById('nm-stats-btn').addEventListener('click', toggleStats);
    document.getElementById('nm-drawer-close').addEventListener('click', closeDrawer);
    document.getElementById('nm-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'nm-overlay') closeDrawer();
    });
    document.getElementById('nm-filter').addEventListener('input', (e) => {
      filterText = e.target.value.toLowerCase();
      renderFileList();
    });
    document.getElementById('nm-batch-apply').addEventListener('click', applyBatchTags);
    document.getElementById('nm-batch-clear').addEventListener('click', () => {
      selectedFiles.clear();
      updateBatchBar();
      renderFileList();
    });

    // Tabs
    document.getElementById('nm-main-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.bt-tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });

    // Download tab
    document.getElementById('nm-dl-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doDownload();
    });
    document.getElementById('nm-dl-btn').addEventListener('click', doDownload);

    // Live download progress via WebSocket
    dlWsHandler = (data) => {
      if (data && data.downloadId) {
        activeDownloads.set(data.downloadId, data);
        renderActiveDownloads();
        if (data.status === 'completed' || (data.stage === 'completed' && data.percent >= 100)) {
          // A new track landed in the library — refresh the browser so it appears.
          loadFolder(currentPath);
        }
      }
    };
    WsClient.subscribe('music-download:progress', dlWsHandler);

    // Wire up the global player. The bar lives in the app shell (persists
    // across route changes); this component feeds it tracks and reacts to
    // trackchange events to keep the row highlight in sync.
    if (typeof App !== 'undefined' && App.Player) {
      App.Player.on('trackchange', (t) => {
        currentPlayingFile = t ? t.name : null;
        playerFilePath = t ? t.path : null;
        updatePlayerHighlight();
      });
    }

    loadFolder('');
    pollActive();
  }

  async function loadFolder(rel) {
    currentPath = rel;
    selectedFiles.clear();
    filterText = '';
    const filterEl = document.getElementById('nm-filter');
    if (filterEl) filterEl.value = '';
    updateBatchBar();

    try {
      browseData = await Api.get(`${API}/browse?path=${encodeURIComponent(rel)}`);
      renderBreadcrumb();
      renderFolders();
      renderFileList();
      loadBatchMeta(rel);
    } catch (err) {
      const el = document.getElementById('nm-list');
      if (el) el.innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  async function loadBatchMeta(rel) {
    try {
      const data = await Api.get(`${API}/batch-metadata?path=${encodeURIComponent(rel)}&limit=200`);
      batchMeta = {};
      for (const item of data) {
        if (item.file?.name) batchMeta[item.file.name] = item;
      }
      renderFileList();
      // The global player keeps its own info; re-render the file row highlight
      // so the currently playing row stays marked.
      if (currentPlayingFile) updatePlayerHighlight();
    } catch { /* silent */ }
  }

  function renderBreadcrumb() {
    const el = document.getElementById('nm-breadcrumb');
    if (!el) return;
    const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
    let html = `<span class="nm-crumb nm-crumb-link" data-path="">/ root</span>`;
    let acc = '';
    for (const p of parts) {
      acc += (acc ? '/' : '') + p;
      html += ` <span class="text-muted">&gt;</span> <span class="nm-crumb nm-crumb-link" data-path="${esc(acc)}">${esc(p)}</span>`;
    }
    if (browseData) {
      html += `<span class="text-muted nm-file-count">${browseData.total} file${browseData.total !== 1 ? 's' : ''}</span>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.nm-crumb-link').forEach((s) =>
      s.addEventListener('click', () => loadFolder(s.dataset.path))
    );
  }

  function renderFolders() {
    const el = document.getElementById('nm-folders');
    if (!el || !browseData) return;
    if (browseData.folders.length === 0 && !currentPath) {
      el.innerHTML = '';
      return;
    }
    let html = '';
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      html += `<span class="nm-folder-tag" data-path="${esc(parent)}">[..]</span>`;
    }
    for (const f of browseData.folders) {
      const p = currentPath ? `${currentPath}/${f.name}` : f.name;
      html += `<span class="nm-folder-tag" data-path="${esc(p)}">${esc(f.name)}/</span>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.nm-folder-tag').forEach((s) =>
      s.addEventListener('click', () => loadFolder(s.dataset.path))
    );
  }

  function renderFileList() {
    const el = document.getElementById('nm-list');
    if (!el || !browseData) return;

    let files = browseData.files;
    if (filterText) {
      files = files.filter((f) => {
        const meta = batchMeta[f.name]?.meta;
        const hay = [f.name, trim(meta?.artist), trim(meta?.album), trim(meta?.title)].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(filterText);
      });
    }

    if (files.length === 0) {
      el.innerHTML = '<span class="text-dim">no audio files</span>';
      return;
    }

    const header = `<tr>
      <th style="width:30px"><input type="checkbox" id="nm-select-all" /></th>
      <th style="width:30px"></th>
      <th style="width:30px"></th>
      <th>name</th><th>format</th><th>artist</th><th>album</th><th>duration</th><th>size</th>
    </tr>`;

    const rows = files.map((f) => {
      const meta = batchMeta[f.name]?.meta;
      const audio = batchMeta[f.name]?.audio;
      const dur = audio?.duration ? fmtDuration(audio.duration) : '--';
      const checked = selectedFiles.has(f.name) ? 'checked' : '';
      return `<tr class="nm-file-row${f.name === currentPlayingFile ? ' nm-file-row-playing' : ''}" data-name="${esc(f.name)}">
        <td><input type="checkbox" class="nm-file-check" data-name="${esc(f.name)}" ${checked} /></td>
        <td><button class="nm-row-play" data-name="${esc(f.name)}">&#9654;</button></td>
        <td><button class="nm-row-dl" data-name="${esc(f.name)}" title="download">&#8681;</button></td>
        <td class="nm-file-name">${esc(trim(meta?.title) || stripExt(f.name))}</td>
        <td class="text-muted">${esc(f.extension)}</td>
        <td class="text-dim">${esc(trim(meta?.artist) || '--')}</td>
        <td class="text-dim">${esc(trim(meta?.album) || '--')}</td>
        <td class="text-dim">${dur}</td>
        <td class="text-dim">${fmtBytes(f.size)}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `<table class="table-console">${header}${rows}</table>`;

    el.querySelectorAll('.nm-file-name').forEach((td) => {
      td.style.cursor = 'pointer';
      td.addEventListener('click', () => {
        const name = td.closest('tr').dataset.name;
        openDrawer(name);
      });
    });

    el.querySelectorAll('.nm-row-play').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        playTrack(name);
      });
    });

    el.querySelectorAll('.nm-row-dl').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fp = currentPath ? `${currentPath}/${btn.dataset.name}` : btn.dataset.name;
        window.open(`${API}/download?path=${encodeURIComponent(fp)}`);
      });
    });

    el.querySelectorAll('.nm-file-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedFiles.add(cb.dataset.name);
        else selectedFiles.delete(cb.dataset.name);
        updateBatchBar();
      });
    });

    const selectAll = document.getElementById('nm-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        const cbs = el.querySelectorAll('.nm-file-check');
        cbs.forEach((cb) => {
          cb.checked = selectAll.checked;
          if (selectAll.checked) selectedFiles.add(cb.dataset.name);
          else selectedFiles.delete(cb.dataset.name);
        });
        updateBatchBar();
      });
    }
  }

  function updateBatchBar() {
    const bar = document.getElementById('nm-batch-bar');
    const count = document.getElementById('nm-batch-count');
    if (!bar) return;
    if (selectedFiles.size > 0) {
      bar.classList.remove('hidden');
      count.textContent = `${selectedFiles.size} selected`;
    } else {
      bar.classList.add('hidden');
    }
  }

  // Build a queue from the currently visible (filtered) file list and play
  // the clicked track. The global player handles autoplay-next from there.
  function playTrack(name) {
    if (typeof App === 'undefined' || !App.Player) return;

    const visibleFiles = getVisibleFiles();
    const queue = visibleFiles.map((f) => buildTrack(f));

    App.Player.enqueue(queue);

    const startTrack = queue.find((t) => t.name === name) || buildTrack({ name });
    App.Player.play(startTrack);
  }

  function buildTrack(f) {
    const meta = batchMeta[f.name]?.meta;
    const path = currentPath ? `${currentPath}/${f.name}` : f.name;
    return {
      name: f.name,
      path,
      title: trim(meta?.title) || stripExt(f.name),
      artist: trim(meta?.artist) || '',
    };
  }

  // Mirrors the same filtering logic as renderFileList so the queue matches
  // what the user sees on screen.
  function getVisibleFiles() {
    if (!browseData) return [];
    if (!filterText) return browseData.files;
    return browseData.files.filter((f) => {
      const meta = batchMeta[f.name]?.meta;
      const hay = [f.name, trim(meta?.artist), trim(meta?.album), trim(meta?.title)]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(filterText);
    });
  }

  function updatePlayerHighlight() {
    const rows = document.querySelectorAll('.nm-file-row');
    rows.forEach((row) => {
      row.classList.toggle('nm-file-row-playing', row.dataset.name === currentPlayingFile);
    });
  }

  async function applyBatchTags() {
    const artist = document.getElementById('nm-batch-artist').value.trim();
    const album = document.getElementById('nm-batch-album').value.trim();
    const genre = document.getElementById('nm-batch-genre').value.trim();

    const tags = {};
    if (artist) tags.artist = artist;
    if (album) tags.album = album;
    if (genre) tags.genre = genre;

    if (Object.keys(tags).length === 0) {
      App.toast('Enter at least one tag value', 'warn');
      return;
    }

    const files = Array.from(selectedFiles).map((name) => ({
      path: currentPath ? `${currentPath}/${name}` : name,
      tags,
    }));

    try {
      const results = await Api.post(`${API}/batch-tag`, { files });
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok).length;
      App.toast(`Tagged ${ok} file${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'ok');
      selectedFiles.clear();
      updateBatchBar();
      document.getElementById('nm-batch-artist').value = '';
      document.getElementById('nm-batch-album').value = '';
      document.getElementById('nm-batch-genre').value = '';
      loadBatchMeta(currentPath);
    } catch (err) {
      App.toast(`Batch tag error: ${err.message}`, 'error');
    }
  }

  async function openDrawer(name) {
    drawerFile = name;
    editing = false;
    drawerMeta = null;
    confirmTarget = null;
    syncState = null;
    syncData = null;
    syncSearch = { title: '', artist: '' };

    document.getElementById('nm-drawer-title').textContent = name;
    document.getElementById('nm-drawer-body').innerHTML = '<span class="text-dim">loading metadata...</span>';
    document.getElementById('nm-overlay').classList.remove('hidden');

    try {
      const filePath = currentPath ? `${currentPath}/${name}` : name;
      drawerMeta = await Api.get(`${API}/metadata?path=${encodeURIComponent(filePath)}`);
      renderDrawerContent();
    } catch (err) {
      document.getElementById('nm-drawer-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
    }
  }

  function closeDrawer() {
    document.getElementById('nm-overlay').classList.add('hidden');
    drawerFile = null;
    drawerMeta = null;
    editing = false;
    confirmTarget = null;
    syncState = null;
    syncData = null;
  }

  function renderDrawerContent() {
    const body = document.getElementById('nm-drawer-body');
    if (!body || !drawerMeta) return;

    const a = drawerMeta.audio || {};
    const m = drawerMeta.meta || {};
    const f = drawerMeta.file || {};
    const filePath = currentPath ? `${currentPath}/${drawerFile}` : drawerFile;

    const dur = a.duration ? fmtDuration(a.duration) : '--';
    const bitrate = a.bitrate ? `${a.bitrate} kbps` : '--';
    const sampleRate = a.sampleRate ? `${a.sampleRate} Hz` : '--';
    const channels = a.channels?.description || '--';
    const hasCover = m.embeddedPictures?.some((p) => p.hasData);

    const coverHtml = hasCover
      ? `<img class="nm-cover-art" src="${API}/cover-art?path=${encodeURIComponent(filePath)}" alt="cover" />`
      : `<div class="nm-cover-art nm-cover-placeholder">[no cover]</div>`;

    const tagFields = [
      { key: 'title', label: 'title' },
      { key: 'artist', label: 'artist' },
      { key: 'album', label: 'album' },
      { key: 'albumArtist', label: 'album artist' },
      { key: 'genre', label: 'genre' },
      { key: 'composer', label: 'composer' },
      { key: 'trackNumber', label: 'track #' },
      { key: 'trackTotal', label: 'track total' },
      { key: 'discNumber', label: 'disc #' },
      { key: 'discTotal', label: 'disc total' },
      { key: 'recordingDate', label: 'year / date' },
      { key: 'publisher', label: 'publisher' },
      { key: 'comment', label: 'comment' },
    ];

    if (editing) {
      for (const tf of tagFields) {
        if (!(tf.key in editTags)) {
          editTags[tf.key] = trim(m[tf.key] != null ? String(m[tf.key]) : '');
        }
      }
    }

    let tagsHtml = '';
    for (const tf of tagFields) {
      if (editing) {
        tagsHtml += `<div class="nm-tag-row">
          <span class="nm-tag-label">${tf.label}</span>
          <input type="text" class="form-input nm-tag-input" data-key="${tf.key}" value="${esc(editTags[tf.key] || '')}" />
        </div>`;
      } else {
        const val = trim(m[tf.key] != null ? String(m[tf.key]) : '');
        tagsHtml += `<div class="nm-tag-row">
          <span class="nm-tag-label">${tf.label}</span>
          <span class="nm-tag-value">${esc(val) || '<span class="text-muted">--</span>'}</span>
        </div>`;
      }
    }

    let syncPreviewHtml = '';
    if (syncState === 'preview' && syncData) {
      const syncFields = [
        { key: 'title', label: 'title' },
        { key: 'artist', label: 'artist' },
        { key: 'album', label: 'album' },
        { key: 'albumArtist', label: 'album artist' },
        { key: 'genre', label: 'genre' },
        { key: 'trackNumber', label: 'track #' },
        { key: 'discNumber', label: 'disc #' },
        { key: 'recordingDate', label: 'year / date' },
      ];
      let rows = '';
      for (const sf of syncFields) {
        const cur = trim(m[sf.key] != null ? String(m[sf.key]) : '');
        const proposed = syncData[sf.key] != null ? String(syncData[sf.key]) : '';
        const changed = proposed && proposed !== cur;
        rows += `<div class="nm-sync-row${changed ? ' nm-sync-row-changed' : ''}">
          <span class="nm-tag-label">${sf.label}</span>
          <span class="nm-sync-current text-dim">${esc(cur) || '--'}</span>
          <span class="nm-sync-arrow text-muted">&rarr;</span>
          <span class="nm-sync-proposed${changed ? ' text-ok' : ''}">${esc(proposed) || '--'}</span>
        </div>`;
      }
      if (syncData.releaseId) {
        rows += `<div class="nm-sync-row nm-sync-row-changed">
          <span class="nm-tag-label">cover art</span>
          <span class="nm-sync-current text-dim">${hasCover ? 'yes' : 'no'}</span>
          <span class="nm-sync-arrow text-muted">&rarr;</span>
          <span class="nm-sync-proposed text-ok">download from MusicBrainz</span>
        </div>`;
      }
      syncPreviewHtml = `
        <div class="nm-sync-preview">
          <div class="nm-detail-heading text-muted" style="margin-bottom:8px">MUSICBRAINZ SYNC PREVIEW</div>
          ${rows}
          <div class="flex gap-8" style="margin-top:10px">
            <button class="btn-console btn-sm btn-ok" id="nm-sync-apply">apply</button>
            <button class="btn-console btn-sm" id="nm-sync-cancel">cancel</button>
          </div>
        </div>`;
    }

    let syncBtnHtml = '';
    if (!editing) {
      if (syncState === 'searching') {
        syncBtnHtml = `<button class="btn-console btn-sm" disabled>searching...</button>`;
      } else if (syncState === 'applying') {
        syncBtnHtml = `<button class="btn-console btn-sm" disabled>applying...</button>`;
      } else if (syncState !== 'preview' && syncState !== 'form') {
        syncBtnHtml = `<button class="btn-console btn-sm btn-warn" id="nm-sync-btn">sync</button>`;
      }
    }

    let syncFormHtml = '';
    if (syncState === 'form') {
      syncFormHtml = `
        <div class="nm-sync-preview nm-sync-preview-amber">
          <div class="nm-detail-heading text-muted" style="margin-bottom:8px">MUSICBRAINZ SEARCH</div>
          <div class="nm-tag-row" style="margin-bottom:6px">
            <span class="nm-tag-label">title</span>
            <input type="text" class="form-input nm-tag-input" id="nm-sync-title" value="${esc(syncSearch.title)}" />
          </div>
          <div class="nm-tag-row" style="margin-bottom:8px">
            <span class="nm-tag-label">artist</span>
            <input type="text" class="form-input nm-tag-input" id="nm-sync-artist" value="${esc(syncSearch.artist)}" />
          </div>
          <div class="flex gap-8">
            <button class="btn-console btn-sm btn-ok" id="nm-sync-search">search</button>
            <button class="btn-console btn-sm" id="nm-sync-form-cancel">cancel</button>
          </div>
        </div>`;
    }

    body.innerHTML = `
      <div class="nm-detail-section">
        <div class="nm-detail-heading text-muted">AUDIO INFO</div>
        <div class="nm-audio-header">
          ${coverHtml}
          <div class="nm-info-grid">
            <div class="nm-info-item"><span class="nm-info-label">format</span><span>${esc(a.format || '--')}</span></div>
            <div class="nm-info-item"><span class="nm-info-label">bitrate</span><span>${bitrate}</span></div>
            <div class="nm-info-item"><span class="nm-info-label">sample rate</span><span>${sampleRate}</span></div>
            <div class="nm-info-item"><span class="nm-info-label">channels</span><span>${esc(channels)}</span></div>
            <div class="nm-info-item"><span class="nm-info-label">duration</span><span>${dur}</span></div>
            <div class="nm-info-item"><span class="nm-info-label">size</span><span>${fmtBytes(f.size)}</span></div>
          </div>
        </div>
      </div>
      <div class="nm-detail-section">
        <div class="flex justify-between items-center" style="margin-bottom:8px">
          <span class="nm-detail-heading text-muted" style="margin-bottom:0">TAGS</span>
          <div class="flex gap-8">
            ${syncBtnHtml}
            ${editing
              ? `<button class="btn-console btn-sm" id="nm-tag-dry">dry-run</button>
                 <button class="btn-console btn-sm btn-ok" id="nm-tag-save">save tags</button>
                 <button class="btn-console btn-sm" id="nm-tag-cancel">cancel</button>`
              : `<button class="btn-console btn-sm" id="nm-tag-edit">edit</button>`}
          </div>
        </div>
        <div class="nm-tag-grid">${tagsHtml}</div>
      </div>
      ${syncFormHtml}
      ${syncPreviewHtml}
      <div class="nm-detail-section" style="margin-top:16px;border-top:1px solid var(--color-rule);padding-top:12px">
        <div class="flex gap-8">
          <button class="btn-console btn-sm btn-ok" id="nm-file-download">download file</button>
          <button class="btn-console btn-sm btn-err" id="nm-file-delete">delete file</button>
        </div>
      </div>`;

    if (editing) {
      body.querySelectorAll('.nm-tag-input').forEach((inp) => {
        inp.addEventListener('input', () => { editTags[inp.dataset.key] = inp.value; });
      });
      const saveBtn = document.getElementById('nm-tag-save');
      if (saveBtn) saveBtn.addEventListener('click', () => saveTags(false));
      const dryBtn = document.getElementById('nm-tag-dry');
      if (dryBtn) dryBtn.addEventListener('click', () => saveTags(true));
      const cancelBtn = document.getElementById('nm-tag-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => { editing = false; editTags = {}; renderDrawerContent(); });
    } else {
      const editBtn = document.getElementById('nm-tag-edit');
      if (editBtn) editBtn.addEventListener('click', () => { editing = true; editTags = {}; renderDrawerContent(); });
    }

    const syncBtn = document.getElementById('nm-sync-btn');
    if (syncBtn) syncBtn.addEventListener('click', openSyncForm);

    const syncSearchBtn = document.getElementById('nm-sync-search');
    if (syncSearchBtn) {
      syncSearchBtn.addEventListener('click', () => {
        syncSearch.title = document.getElementById('nm-sync-title').value.trim();
        syncSearch.artist = document.getElementById('nm-sync-artist').value.trim();
        doSyncSearch();
      });
    }

    const syncFormCancelBtn = document.getElementById('nm-sync-form-cancel');
    if (syncFormCancelBtn) syncFormCancelBtn.addEventListener('click', () => { syncState = null; syncData = null; renderDrawerContent(); });

    const syncApplyBtn = document.getElementById('nm-sync-apply');
    if (syncApplyBtn) syncApplyBtn.addEventListener('click', applySyncMetadata);

    const syncCancelBtn = document.getElementById('nm-sync-cancel');
    if (syncCancelBtn) syncCancelBtn.addEventListener('click', () => { syncState = 'form'; syncData = null; renderDrawerContent(); });

    const dlBtn = document.getElementById('nm-file-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', () => {
        const fp = currentPath ? `${currentPath}/${drawerFile}` : drawerFile;
        window.open(`${API}/download?path=${encodeURIComponent(fp)}`);
      });
    }

    const delBtn = document.getElementById('nm-file-delete');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        const fp = currentPath ? `${currentPath}/${drawerFile}` : drawerFile;
        if (confirmTarget === fp) {
          confirmTarget = null;
          doDelete(fp);
        } else {
          confirmTarget = fp;
          delBtn.textContent = '[confirm?]';
          setTimeout(() => {
            if (confirmTarget === fp) {
              confirmTarget = null;
              delBtn.textContent = 'delete file';
            }
          }, 3000);
        }
      });
    }

    if (currentPlayingFile) updatePlayerHighlight();
  }

  function openSyncForm() {
    if (!drawerMeta) return;
    const m = drawerMeta.meta || {};
    syncSearch.title = trim(m.title) || stripExt(drawerFile);
    syncSearch.artist = trim(m.artist) || '';
    syncState = 'form';
    syncData = null;
    renderDrawerContent();
  }

  async function doSyncSearch() {
    const title = syncSearch.title;
    const artist = syncSearch.artist;
    if (!title && !artist) {
      App.toast('Enter a title or artist to search', 'warn');
      return;
    }

    syncState = 'searching';
    syncData = null;
    renderDrawerContent();

    try {
      const qs = new URLSearchParams({ title, artist }).toString();
      const result = await Api.get(`${API}/search-metadata?${qs}`);
      if (!result.found) {
        App.toast('No MusicBrainz results found', 'warn');
        syncState = 'form';
        renderDrawerContent();
        return;
      }
      syncData = result.metadata;
      syncState = 'preview';
      renderDrawerContent();
    } catch (err) {
      App.toast(`Sync search error: ${err.message}`, 'error');
      syncState = 'form';
      renderDrawerContent();
    }
  }

  async function applySyncMetadata() {
    if (!syncData || !drawerFile) return;
    const filePath = currentPath ? `${currentPath}/${drawerFile}` : drawerFile;

    syncState = 'applying';
    renderDrawerContent();

    try {
      await Api.post(`${API}/apply-sync`, { path: filePath, metadata: syncData });
      App.toast('MusicBrainz tags applied', 'ok');
      syncState = null;
      syncData = null;
      drawerMeta = await Api.get(`${API}/metadata?path=${encodeURIComponent(filePath)}`);
      renderDrawerContent();
      loadBatchMeta(currentPath);
    } catch (err) {
      App.toast(`Sync apply error: ${err.message}`, 'error');
      syncState = 'preview';
      renderDrawerContent();
    }
  }

  async function saveTags(dryRun) {
    const filePath = currentPath ? `${currentPath}/${drawerFile}` : drawerFile;
    const tags = {};
    for (const [k, v] of Object.entries(editTags)) {
      if (v !== '' || (drawerMeta?.meta?.[k] != null && String(drawerMeta.meta[k]) !== v)) {
        tags[k] = v;
      }
    }

    if (Object.keys(tags).length === 0) {
      App.toast('No changes to save', 'warn');
      return;
    }

    try {
      const result = await Api.post(`${API}/tag`, { path: filePath, tags, dryRun });
      if (dryRun) {
        App.toast(`Dry run OK: ${result.output || 'no issues'}`, 'ok');
      } else {
        App.toast('Tags saved', 'ok');
        editing = false;
        editTags = {};
        drawerMeta = await Api.get(`${API}/metadata?path=${encodeURIComponent(filePath)}`);
        renderDrawerContent();
        loadBatchMeta(currentPath);
        if (currentPlayingFile) updatePlayerHighlight();
      }
    } catch (err) {
      App.toast(`Tag error: ${err.message}`, 'error');
    }
  }

  async function doDelete(filePath) {
    try {
      await Api.post(`${API}/delete`, { path: filePath });
      App.toast('File deleted', 'ok');
      if (typeof App !== 'undefined' && App.Player) {
        // If the deleted file is the one playing, skip past it. If it was
        // upcoming, the global player will simply not hit it on autoplay.
        App.Player.advancePast(filePath);
      }
      closeDrawer();
      loadFolder(currentPath);
    } catch (err) {
      App.toast(`Delete error: ${err.message}`, 'error');
    }
  }

  async function toggleStats() {
    const panel = document.getElementById('nm-stats-panel');
    if (!panel) return;
    statsVisible = !statsVisible;
    panel.classList.toggle('hidden', !statsVisible);
    if (statsVisible && !statsData) {
      try {
        statsData = await Api.get(`${API}/stats`);
        renderStats();
      } catch (err) {
        document.getElementById('nm-stats-body').innerHTML = `<span class="text-err">ERR: ${esc(err.message)}</span>`;
      }
    }
  }

  function renderStats() {
    const el = document.getElementById('nm-stats-body');
    if (!el || !statsData) return;

    const extRows = Object.entries(statsData.byExtension)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `<div class="nm-stat-row"><span class="text-dim">.${ext}</span><span>${count}</span></div>`)
      .join('');

    const folderRows = Object.entries(statsData.byFolder)
      .sort((a, b) => b[1] - a[1])
      .map(([folder, count]) => `<div class="nm-stat-row"><span class="text-dim">${esc(folder)}</span><span>${count}</span></div>`)
      .join('');

    el.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:16px">
        <div class="nm-stat-card">
          <div class="nm-stat-value">${statsData.totalFiles}</div>
          <div class="nm-stat-label">total files</div>
        </div>
        <div class="nm-stat-card">
          <div class="nm-stat-value">${fmtBytes(statsData.totalSize)}</div>
          <div class="nm-stat-label">total size</div>
        </div>
        <div class="nm-stat-card">
          <div class="nm-stat-value">${Object.keys(statsData.byExtension).length}</div>
          <div class="nm-stat-label">formats</div>
        </div>
      </div>
      <div class="grid grid-2">
        <div>
          <div class="text-muted mb-8" style="font-size:11px;text-transform:uppercase">by extension</div>
          ${extRows}
        </div>
        <div>
          <div class="text-muted mb-8" style="font-size:11px;text-transform:uppercase">by folder</div>
          ${folderRows}
        </div>
      </div>`;
  }

  function fmtDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  function fmtBytes(b) {
    if (!b) return '--';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function trim(s) {
    return s?.trim() || '';
  }

  function stripExt(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function destroy() {
    if (dlWsHandler) {
      WsClient.unsubscribe('music-download:progress', dlWsHandler);
      dlWsHandler = null;
    }
    activeDownloads.clear();
    activeTab = 'library';
    browseData = null;
    batchMeta = {};
    selectedFiles.clear();
    statsData = null;
    drawerMeta = null;
    confirmTarget = null;
    syncState = null;
    syncData = null;
    currentPlayingFile = null;
    playerFilePath = null;
  }

  return { render, destroy };
})();
