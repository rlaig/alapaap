'use strict';

const ExploreWorkspaceComponent = (() => {
  const API = '/api/explore-workspace';
  let currentSource = null;
  let sourceList = [];
  let currentPath = '';
  let tabs = [];
  let activeTabIdx = -1;
  let gitFiles = [];
  let gitBranch = null;
  let gitIsRepo = false;
  let gitLoaded = false;
  let selectedGitFile = null;
  let gitShowStaged = false;
  let activePane = 'files';
  let currentCustomWorkspaceRoot = null;
  let currentCustomGitRoot = null;

  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']);
  const MD_EXTENSIONS = new Set(['md', 'markdown']);
  const COMMENT_MAP = {
    js: '//', ts: '//', jsx: '//', tsx: '//', mjs: '//', cjs: '//',
    json: '//', jsonl: '//',
    py: '#', rb: '#', sh: '#', bash: '#', zsh: '#', yml: '#', yaml: '#', toml: '#',
    css: '//', scss: '//', less: '//',
    rs: '//', go: '//', java: '//', c: '//', cpp: '//', h: '//',
  };

  // ─── Helpers ───

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function filenameFromPath(path) {
    if (!path) return '';
    const parts = path.split('/');
    return parts[parts.length - 1];
  }

  function activeTab() {
    return activeTabIdx >= 0 && activeTabIdx < tabs.length ? tabs[activeTabIdx] : null;
  }

  function openFilePath() {
    const tab = activeTab();
    return tab ? tab.path : null;
  }

  // ─── Per-tab textarea helpers ───

  function getActiveEditor() {
    const tab = activeTab();
    return tab && tab._textarea ? tab._textarea : null;
  }

  function createTextareaForTab(tab) {
    const stack = document.getElementById('nw-editor-stack');
    if (!stack) return null;
    const ta = document.createElement('textarea');
    ta.className = 'nw-textarea';
    ta.spellcheck = false;
    ta.value = tab.content || '';
    ta.disabled = !!tab.locked;
    ta.style.cssText =
      `position:absolute;inset:0;width:100%;height:100%;resize:none;border:none;outline:none;` +
      `background:var(--bg-secondary,#1a1a2e);color:var(--text,#e0e0e0);` +
      `font-family:'JetBrains Mono',Menlo,monospace;font-size:13px;line-height:1.5;` +
      `padding:10px 12px 10px 48px;box-sizing:border-box;tab-size:2;white-space:pre-wrap;` +
      `display:none;`;
    ta.addEventListener('input', onEditorInput);
    ta.addEventListener('keydown', onEditorKeydown);
    ta.addEventListener('click', updateCursorPos);
    ta.addEventListener('keyup', updateCursorPos);
    ta.addEventListener('scroll', syncLineNumbers);
    stack.appendChild(ta);
    tab._textarea = ta;
    return ta;
  }

  function removeTextareaForTab(tab) {
    if (tab && tab._textarea && tab._textarea.parentNode) {
      tab._textarea.parentNode.removeChild(tab._textarea);
    }
    if (tab) tab._textarea = null;
  }

  // ─── Tab state helpers ───

  function saveCurrentTabState() {
    const tab = activeTab();
    if (!tab || !tab._textarea) return;
    // The textarea IS the state; only capture cursor/scroll for restoration on switch back.
    tab.cursorStart = tab._textarea.selectionStart;
    tab.cursorEnd = tab._textarea.selectionEnd;
    tab.scrollPos = tab._textarea.scrollTop;
  }

  function restoreTabState(idx) {
    const tab = tabs[idx];
    if (!tab) return;
    activeTabIdx = idx;

    const imgPreview = document.getElementById('nw-image-preview');
    const mdPreview = document.getElementById('nw-markdown-preview');
    const gutter = document.getElementById('nw-line-numbers');

    // Toggle every tab textarea — show only the active one (and only when in editor view)
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (t._textarea) {
        const visible = (i === idx && tab.viewMode === 'editor');
        t._textarea.style.display = visible ? '' : 'none';
      }
    }

    gutter.style.display = tab.viewMode === 'editor' ? '' : 'none';
    imgPreview.style.display = tab.viewMode === 'image' ? 'flex' : 'none';
    mdPreview.style.display = tab.viewMode === 'markdown' ? '' : 'none';

    if (tab.viewMode === 'image') {
      const imgEl = document.getElementById('nw-image-el');
      if (imgEl) imgEl.src = tab.imageDataUrl || '';
    } else if (tab.viewMode === 'markdown') {
      renderMarkdown(tab.content);
    } else if (tab._textarea) {
      // Restore cursor & scroll in next frame so layout is ready
      requestAnimationFrame(() => {
        tab._textarea.selectionStart = tab.cursorStart || 0;
        tab._textarea.selectionEnd = tab.cursorEnd || 0;
        tab._textarea.scrollTop = tab.scrollPos || 0;
      });
      updateLineNumbers();
      updateCursorPos();
    }

    // Update toolbar
    document.getElementById('nw-file-label').textContent = tab.path || 'no file open';
    document.getElementById('nw-dirty-badge').style.display = tab.dirty ? 'inline' : 'none';
    document.getElementById('nw-close-btn').disabled = false;
    document.getElementById('nw-refresh-btn').disabled = false;

    const isImage = tab.viewMode === 'image';
    const isMd = tab.viewMode !== 'image' && isMarkdownFile(tab.path);

    document.getElementById('nw-save-btn').disabled = isImage || tab.locked || false;
    document.getElementById('nw-revert-btn').disabled = isImage;
    document.getElementById('nw-rename-btn').disabled = isImage || tab.locked || tab.protected || false;
    document.getElementById('nw-delete-btn').disabled = isImage || tab.locked || tab.protected || false;

    if (isMd) {
      document.getElementById('nw-preview-btn').style.display = '';
      document.getElementById('nw-preview-btn').textContent = tab.mdPreviewMode ? 'edit' : 'preview';
    } else {
      document.getElementById('nw-preview-btn').style.display = 'none';
    }

    // Update status bar
    if (tab.viewMode === 'image') {
      document.getElementById('nw-status-lines').textContent = 'image';
    } else if (tab.viewMode === 'markdown' || !tab._textarea) {
      document.getElementById('nw-status-lines').textContent = `${(tab.content || '').split('\n').length} lines`;
    } else {
      document.getElementById('nw-status-lines').textContent = `${tab._textarea.value.split('\n').length} lines`;
    }
    document.getElementById('nw-status-size').textContent = tab.size != null ? fmtSize(tab.size) : '--';
    document.getElementById('nw-status-modified').textContent = tab.modified ? fmtDate(tab.modified) : '--';
    document.getElementById('nw-status-protected').textContent = tab.protected ? '[protected]' : '';
    document.getElementById('nw-status-protected').style.color = tab.protected ? 'var(--warning,#f0ad4e)' : '';
    document.getElementById('nw-cursor-pos').textContent = tab.viewMode === 'editor' ? `Ln 1, Col 1` : '';

    renderTabBar();
  }

  function getOrCreateTab(path) {
    let idx = tabs.findIndex(t => t.path === path);
    if (idx !== -1) return idx;
    const newTab = {
      path,
      originalContent: '',
      content: '',
      dirty: false,
      mdPreviewMode: false,
      viewMode: 'editor',
      scrollPos: 0,
      cursorStart: 0,
      cursorEnd: 0,
      imageDataUrl: '',
      locked: false,
      protected: false,
      size: null,
      modified: null,
    };
    tabs.push(newTab);
    createTextareaForTab(newTab);
    return tabs.length - 1;
  }

  function activateTab(idx) {
    if (idx < 0 || idx >= tabs.length || idx === activeTabIdx) return;
    saveCurrentTabState();
    restoreTabState(idx);
    loadDir(currentPath); // refresh file list highlights
  }

  function closeTab(idx) {
    if (idx < 0 || idx >= tabs.length) return;
    const tab = tabs[idx];
    if (tab.dirty && !confirm(`Unsaved changes in "${filenameFromPath(tab.path)}". Close anyway?`)) return;

    removeTextareaForTab(tab);
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      activeTabIdx = -1;
      resetEditor();
    } else if (idx === activeTabIdx) {
      // Activate adjacent tab
      const next = Math.min(idx, tabs.length - 1);
      restoreTabState(next);
    } else if (idx < activeTabIdx) {
      activeTabIdx--;
    }

    renderTabBar();
    loadDir(currentPath);
  }

  function closeAllTabs() {
    tabs.forEach(removeTextareaForTab);
    tabs = [];
    activeTabIdx = -1;
    resetEditor();
    renderTabBar();
  }

  function resetEditor() {
    const imgPreview = document.getElementById('nw-image-preview');
    const mdPreview = document.getElementById('nw-markdown-preview');
    const gutter = document.getElementById('nw-line-numbers');

    // Hide all tab textareas (closeAllTabs removes them, but resetEditor may be called with tabs left)
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i]._textarea) tabs[i]._textarea.style.display = 'none';
    }

    if (gutter) gutter.style.display = 'none';
    if (imgPreview) imgPreview.style.display = 'none';
    if (mdPreview) mdPreview.style.display = 'none';

    const imgEl = document.getElementById('nw-image-el');
    if (imgEl) imgEl.src = '';
    if (mdPreview) mdPreview.innerHTML = '';

    document.getElementById('nw-file-label').textContent = 'no file open';
    document.getElementById('nw-dirty-badge').style.display = 'none';
    document.getElementById('nw-close-btn').disabled = true;
    document.getElementById('nw-refresh-btn').disabled = true;
    document.getElementById('nw-save-btn').disabled = true;
    document.getElementById('nw-revert-btn').disabled = true;
    document.getElementById('nw-rename-btn').disabled = true;
    document.getElementById('nw-delete-btn').disabled = true;
    document.getElementById('nw-preview-btn').style.display = 'none';
    document.getElementById('nw-status-lines').textContent = '--';
    document.getElementById('nw-status-size').textContent = '--';
    document.getElementById('nw-status-modified').textContent = '--';
    document.getElementById('nw-status-protected').textContent = '';
    document.getElementById('nw-cursor-pos').textContent = '';
    updateLineNumbers();
  }

  // ─── Tab bar rendering ───

  function renderTabBar() {
    const bar = document.getElementById('nw-tab-bar');
    if (!bar) return;
    if (tabs.length === 0) {
      bar.innerHTML = '';
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    let html = '';
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const isActive = i === activeTabIdx;
      const cls = `nw-tab${isActive ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
      const name = esc(filenameFromPath(tab.path));
      const dirtyMark = tab.dirty ? '<span class="nw-tab-dirty">*</span>' : '';
      html += `<div class="${cls}" data-tab-idx="${i}" title="${esc(tab.path)}">
        <span class="nw-tab-name">${name}</span>${dirtyMark}
        <span class="nw-tab-close" data-tab-close="${i}">&times;</span>
      </div>`;
    }
    bar.innerHTML = html;

    // Scroll active tab into view
    const activeEl = bar.querySelector('.nw-tab.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // Event: click tab to activate
    bar.querySelectorAll('.nw-tab').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('nw-tab-close')) return;
        activateTab(parseInt(el.dataset.tabIdx, 10));
      });
      // Middle-click to close
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(parseInt(el.dataset.tabIdx, 10)); }
      });
    });
    // Event: close button
    bar.querySelectorAll('.nw-tab-close').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(parseInt(el.dataset.tabClose, 10));
      });
    });
  }

  // ─── API helpers ───

  function closeMobileSidebars() {
    if (window.innerWidth < 768) {
      const sidebarOverlay = document.getElementById('nw-sidebar-overlay');
      const sidebar = document.getElementById('nw-sidebar');
      const gitSidebarOverlay = document.getElementById('nw-git-sidebar-overlay');
      const gitSidebar = document.getElementById('nw-git-sidebar');
      if (sidebarOverlay) sidebarOverlay.classList.remove('active');
      if (sidebar) sidebar.classList.remove('nw-mobile-open');
      if (gitSidebarOverlay) gitSidebarOverlay.classList.remove('active');
      if (gitSidebar) gitSidebar.classList.remove('nw-mobile-open');
    }
  }

  function apiUrl(endpoint, params = {}) {
    const sp = new URLSearchParams();
    if (currentSource) sp.set('source', currentSource);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) sp.set(k, v);
    }
    const qs = sp.toString();
    return `${API}/${endpoint}${qs ? '?' + qs : ''}`;
  }

  function isImageFile(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }

  function isMarkdownFile(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    return MD_EXTENSIONS.has(ext);
  }

  function getFileExt(filename) {
    return (filename || '').split('.').pop().toLowerCase();
  }

  function fmtSize(bytes) {
    if (bytes == null) return '--';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function fmtDate(iso) {
    if (!iso) return '--';
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch { return iso; }
  }

  let mobileResizeHandler = null;

  // ─── Render ───

  function render(container) {
    container.innerHTML = `
      <div id="nw-root" class="nw-root">
        <div id="nw-files-panel" class="panel nw-accordion-pane active">
          <div class="panel-header flex justify-between items-center" id="nw-files-panel-header">
            <div class="flex items-center gap-8">
              <span class="nw-collapse-icon">&#9660;</span>
              <span>&gt;_ explore workspace</span>
            </div>
            <div class="flex gap-8">
              <button class="btn-console btn-sm" id="nw-sidebar-toggle" style="display:none" title="Toggle file list">☰ files</button>
              <select id="nw-source-sel" class="form-input" style="width:auto;padding:2px 6px;font-size:12px"></select>
              <button class="btn-console btn-sm" id="nw-set-root-btn" title="Set custom root directory">root</button>
              <button class="btn-console btn-sm" id="nw-new-file-btn">+ file</button>
              <button class="btn-console btn-sm" id="nw-new-dir-btn">+ dir</button>
            </div>
          </div>
          <div class="panel-body nw-workspace-body">
            <div id="nw-main" class="nw-main">
                <div id="nw-sidebar-overlay" class="nw-sidebar-overlay"></div>
                <div id="nw-sidebar" class="nw-sidebar">
                <div id="nw-breadcrumb" style="padding:6px 10px;font-size:11px;border-bottom:1px solid var(--border);word-break:break-all"></div>
                <div id="nw-file-list" style="padding:4px 0"></div>
              </div>
              <div id="nw-editor-area" style="flex:1;display:flex;flex-direction:column;min-width:0">
                <div id="nw-tab-bar" class="nw-tab-bar"></div>
                <div id="nw-editor-toolbar" class="nw-editor-toolbar" style="padding:4px 10px;border-bottom:1px solid var(--border);font-size:11px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <span id="nw-file-label" class="text-dim">no file open</span>
                  <span id="nw-dirty-badge" style="color:var(--accent);font-weight:bold;display:none">*</span>
                  <button class="btn-console btn-sm" id="nw-close-btn" disabled title="Close file" style="padding:1px 5px;font-size:10px">&times;</button>
                  <span style="flex:1"></span>
                  <span id="nw-cursor-pos" class="text-dim" style="font-size:10px"></span>
                  <label style="font-size:10px;display:flex;align-items:center;gap:3px">
                    <input type="checkbox" id="nw-wrap-toggle" checked> wrap
                  </label>
                  <button class="btn-console btn-sm" id="nw-preview-btn" style="display:none">preview</button>
                  <button class="btn-console btn-sm" id="nw-refresh-btn" disabled>refresh</button>
                  <button class="btn-console btn-sm" id="nw-save-btn" disabled>save</button>
                  <span class="nw-toolbar-secondary">
                    <button class="btn-console btn-sm" id="nw-revert-btn" disabled>revert</button>
                    <button class="btn-console btn-sm" id="nw-rename-btn" disabled>rename</button>
                    <button class="btn-console btn-sm" id="nw-delete-btn" disabled>delete</button>
                  </span>
                </div>
                <div id="nw-editor-wrap" style="flex:1;position:relative;overflow:hidden">
                  <div id="nw-line-numbers" style="
                    position:absolute;top:0;left:0;bottom:0;width:40px;
                    overflow:hidden;z-index:1;
                    background:var(--bg-secondary,#1a1a2e);
                    border-right:1px solid var(--border,#1e1e2e);
                    font-family:'JetBrains Mono',Menlo,monospace;font-size:13px;line-height:1.5;
                    padding:10px 4px 10px 0;text-align:right;
                    color:var(--text-muted,#555570);user-select:none;
                    box-sizing:border-box;
                  "></div>
                  <div id="nw-editor-stack" style="position:absolute;top:0;left:0;right:0;bottom:0"></div>
                  <div id="nw-image-preview" style="
                    display:none;position:absolute;inset:0;overflow:auto;
                    background:var(--bg-secondary,#1a1a2e);
                    padding:16px;box-sizing:border-box;
                  ">
                    <img id="nw-image-el" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:4px" />
                  </div>
                  <div id="nw-markdown-preview" style="
                    display:none;position:absolute;inset:0;overflow:auto;
                    background:var(--bg-secondary,#1a1a2e);
                    padding:20px 24px;box-sizing:border-box;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                    font-size:14px;line-height:1.7;color:var(--text-bright,#e0e0f0);
                  "></div>
                </div>
                <div id="nw-status-bar" style="padding:3px 10px;border-top:1px solid var(--border);font-size:10px;display:flex;gap:12px" class="text-dim">
                  <span id="nw-status-lines">--</span>
                  <span id="nw-status-size">--</span>
                  <span id="nw-status-modified">--</span>
                  <span id="nw-status-protected"></span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div id="nw-git-panel" class="panel nw-accordion-pane">
          <div class="panel-header flex justify-between items-center" id="nw-git-panel-header">
            <div class="flex items-center gap-8">
              <span class="nw-collapse-icon">&#9660;</span>
              <span>git changes</span>
              <span id="nw-git-branch" class="text-dim" style="font-size:11px">--</span>
              <span id="nw-git-count" class="text-dim" style="font-size:10px"></span>
            </div>
            <div class="flex gap-8">
              <button class="btn-console btn-sm" id="nw-git-sidebar-toggle" style="display:none" title="Toggle changed files">☰ changes</button>
              <button class="btn-console btn-sm" id="nw-git-set-root-btn" style="font-size:10px" title="Set custom git root">root</button>
              <button class="btn-console btn-sm" id="nw-git-filter-btn" style="font-size:10px">all</button>
              <button class="btn-console btn-sm" id="nw-git-refresh-btn" style="font-size:10px">refresh</button>
            </div>
          </div>
          <div class="panel-body nw-git-body">
            <div class="nw-git-content">
                <div id="nw-git-sidebar-overlay" class="nw-sidebar-overlay"></div>
                <div id="nw-git-sidebar" class="nw-git-sidebar">
                <div id="nw-git-file-list" style="padding:4px 0"></div>
              </div>
              <div id="nw-git-diff-area" style="flex:1;display:flex;flex-direction:column;min-width:0">
                <div id="nw-git-diff-toolbar" style="padding:4px 10px;border-bottom:1px solid var(--border);font-size:11px;display:flex;align-items:center;gap:8px">
                  <span id="nw-git-diff-label" class="text-dim">select a file to view diff</span>
                </div>
                <pre id="nw-git-diff-content" style="
                  flex:1;overflow:auto;margin:0;padding:12px 14px;
                  background:var(--bg-secondary,#1a1a2e);
                  font-family:'JetBrains Mono',Menlo,monospace;font-size:12px;line-height:1.6;
                  color:var(--text-dim,#8888aa);white-space:pre-wrap;word-break:break-all;
                "></pre>
              </div>
            </div>
          </div>
        </div>
      </div>
      <style>
        /* ── Accordion layout: fill the #content viewport ── */
        .nw-root { display:flex; flex-direction:column; height:calc(100vh - var(--topbar-height, 44px) - 32px); }
        .nw-accordion-pane { margin-bottom:0; display:flex; flex-direction:column; min-height:0; }
        .nw-accordion-pane > .panel-header { flex-shrink:0; }
        .nw-accordion-pane > .panel-body { display:none; }
        .nw-accordion-pane.active { flex:1; }
        .nw-accordion-pane.active > .panel-body { display:block; flex:1; min-height:0; }
        .nw-accordion-pane:not(.active) .nw-collapse-icon { transform:rotate(-90deg); }
        .nw-collapse-icon { display:inline-block; font-size:8px; transition:transform 0.15s ease; color:var(--text-muted,#555570); }
        .nw-workspace-body { padding:0; }
        .nw-main { display:flex; height:100%; }
        .nw-sidebar { width:260px; min-width:200px; border-right:1px solid var(--border); overflow-y:auto; }

        /* ── Tab bar ── */
        .nw-tab-bar { display:flex; flex-direction:row; overflow-x:auto; overflow-y:hidden; min-height:0; flex-shrink:0; border-bottom:1px solid var(--border,#1e1e2e); background:var(--bg-primary,#0a0a0f); scrollbar-width:thin; scrollbar-color:var(--border,#1e1e2e) transparent; }
        .nw-tab-bar::-webkit-scrollbar { height:3px; }
        .nw-tab-bar::-webkit-scrollbar-track { background:transparent; }
        .nw-tab-bar::-webkit-scrollbar-thumb { background:var(--border,#1e1e2e); border-radius:2px; }
        .nw-tab { display:flex; align-items:center; gap:4px; padding:5px 10px; font-size:11px; cursor:pointer; white-space:nowrap; border-bottom:2px solid transparent; color:var(--text-dim,#8888aa); flex-shrink:0; max-width:180px; position:relative; user-select:none; transition:background 0.1s ease,color 0.1s ease; }
        .nw-tab:hover { background:rgba(255,255,255,0.03); color:var(--text,#e0e0e0); }
        .nw-tab.active { color:var(--text-bright,#e0e0f0); background:var(--bg-secondary,#1a1a2e); border-bottom-color:var(--accent-blue,#4488ff); }
        .nw-tab-name { overflow:hidden; text-overflow:ellipsis; }
        .nw-tab-dirty { color:var(--accent-amber,#ffaa00); font-weight:bold; font-size:12px; flex-shrink:0; }
        .nw-tab-close { display:none; padding:0 3px; font-size:12px; line-height:1; color:var(--text-muted,#555570); cursor:pointer; border-radius:2px; flex-shrink:0; }
        .nw-tab:hover .nw-tab-close { display:inline-block; }
        .nw-tab-close:hover { color:var(--text,#e0e0e0); background:rgba(255,255,255,0.08); }

        /* ── Git panel body ── */
        .nw-git-body { padding:0; }
        .nw-git-content { display:flex; height:100%; }
        .nw-git-sidebar { width:300px; min-width:200px; border-right:1px solid var(--border); overflow-y:auto; }

        /* ── Markdown preview ── */
        #nw-markdown-preview h1 { font-size:1.8em; font-weight:700; margin:0.6em 0 0.3em; padding-bottom:0.2em; border-bottom:1px solid var(--border,#1e1e2e); }
        #nw-markdown-preview h2 { font-size:1.4em; font-weight:600; margin:0.5em 0 0.3em; padding-bottom:0.15em; border-bottom:1px solid var(--border,#1e1e2e); }
        #nw-markdown-preview h3 { font-size:1.2em; font-weight:600; margin:0.4em 0 0.2em; }
        #nw-markdown-preview h4,#nw-markdown-preview h5,#nw-markdown-preview h6 { font-size:1em; font-weight:600; margin:0.4em 0 0.2em; }
        #nw-markdown-preview p { margin:0.5em 0; }
        #nw-markdown-preview code { font-family:'JetBrains Mono',Menlo,monospace; font-size:0.88em; background:var(--bg-primary,#0a0a0f); padding:2px 5px; border-radius:3px; }
        #nw-markdown-preview pre { background:var(--bg-primary,#0a0a0f); border:1px solid var(--border,#1e1e2e); border-radius:4px; padding:12px 14px; overflow-x:auto; margin:0.6em 0; }
        #nw-markdown-preview pre code { background:none; padding:0; font-size:0.85em; }
        #nw-markdown-preview blockquote { border-left:3px solid var(--accent-blue,#4488ff); padding:4px 12px; margin:0.5em 0; color:var(--text-dim,#8888aa); }
        #nw-markdown-preview ul,#nw-markdown-preview ol { padding-left:1.8em; margin:0.4em 0; }
        #nw-markdown-preview li { margin:0.2em 0; }
        #nw-markdown-preview table { border-collapse:collapse; margin:0.6em 0; width:100%; }
        #nw-markdown-preview th,#nw-markdown-preview td { border:1px solid var(--border,#1e1e2e); padding:6px 10px; text-align:left; }
        #nw-markdown-preview th { background:var(--bg-primary,#0a0a0f); font-weight:600; }
        #nw-markdown-preview tr:nth-child(even) td { background:rgba(255,255,255,0.02); }
        #nw-markdown-preview a { color:var(--accent-blue,#4488ff); }
        #nw-markdown-preview hr { border:none; border-top:1px solid var(--border,#1e1e2e); margin:1em 0; }
        #nw-markdown-preview img { max-width:100%; border-radius:4px; }
        #nw-line-numbers .nw-ln-active { color:var(--text-bright,#e0e0f0); }

        /* ── Git file list & diff ── */
        .nw-git-file { padding:4px 10px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:6px; border-left:3px solid transparent; }
        .nw-git-file:hover { background:rgba(255,255,255,0.03); }
        .nw-git-file.selected { background:rgba(255,255,255,0.05); border-left-color:var(--accent-blue,#4488ff); }
        .nw-git-badge { display:inline-block; width:16px; text-align:center; font-weight:bold; font-size:10px; border-radius:2px; }
        .nw-git-badge-m { color:var(--accent-amber,#ffaa00); }
        .nw-git-badge-a { color:var(--accent-green,#00ff88); }
        .nw-git-badge-d { color:var(--accent-red,#ff4444); }
        .nw-git-badge-r { color:var(--accent-blue,#4488ff); }
        .nw-git-badge-u { color:var(--accent-green,#00ff88); }
        .nw-diff-add { color:#50fa7b; }
        .nw-diff-del { color:#ff5555; }
        .nw-diff-hunk { color:var(--accent-blue,#4488ff); font-weight:bold; }
        .nw-diff-header { color:var(--text-muted,#555570); }

        /* ── Mobile sidebar overlay ── */
        .nw-sidebar-overlay {
          display: none;
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.5);
          z-index: 10;
        }
        .nw-sidebar-overlay.active { display: block; }

        /* ── Mobile (<768px) ── */
        @media (max-width: 767px) {
          #nw-sidebar-toggle { display: inline-block !important; }
          #nw-main { flex-direction: column; position: relative; }
          #nw-sidebar {
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            width: 85%;
            max-width: 300px;
            z-index: 11;
            transform: translateX(-100%);
            transition: transform 0.2s ease;
            min-width: 0;
          }
          #nw-sidebar.nw-mobile-open {
            transform: translateX(0);
          }

          #nw-editor-toolbar { flex-wrap: wrap; }

          #nw-git-sidebar-toggle { display: inline-block !important; }
          .nw-git-content { position: relative; }
          #nw-git-sidebar {
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            width: 85%;
            max-width: 300px;
            z-index: 11;
            transform: translateX(-100%);
            transition: transform 0.2s ease;
            min-width: 0;
          }
          #nw-git-sidebar.nw-mobile-open {
            transform: translateX(0);
          }

          /* File items: larger touch targets */
          .nw-file-item { min-height: 36px; }
          .nw-git-file { min-height: 36px; }
        }

        /* ── Small mobile (<480px) ── */
        @media (max-width: 479px) {
          .nw-tab { max-width: 120px; padding: 4px 6px; font-size: 10px; }
          .nw-tab-close { display: none !important; }
          .nw-toolbar-secondary { display: none; }

          .nw-textarea {
            font-size: 12px;
            line-height: 1.4;
            padding-left: 38px;
          }
          #nw-line-numbers {
            width: 30px;
            font-size: 12px;
            line-height: 1.4;
          }

          #nw-breadcrumb { font-size: 10px; }

          /* Hide cursor pos on very small screens */
          #nw-cursor-pos { display: none; }
        }
      </style>
    `;

    document.getElementById('nw-source-sel').addEventListener('change', onSourceChange);
    document.getElementById('nw-set-root-btn').addEventListener('click', onSetWorkspaceRoot);
    document.getElementById('nw-new-file-btn').addEventListener('click', onNewFile);
    document.getElementById('nw-new-dir-btn').addEventListener('click', onNewDir);
    document.getElementById('nw-close-btn').addEventListener('click', onClose);
    document.getElementById('nw-refresh-btn').addEventListener('click', onRefresh);
    document.getElementById('nw-preview-btn').addEventListener('click', onTogglePreview);
    document.getElementById('nw-save-btn').addEventListener('click', onSave);
    document.getElementById('nw-revert-btn').addEventListener('click', onRevert);
    document.getElementById('nw-rename-btn').addEventListener('click', onRename);
    document.getElementById('nw-delete-btn').addEventListener('click', onDelete);
    document.getElementById('nw-wrap-toggle').addEventListener('change', onWrapToggle);

    document.getElementById('nw-files-panel-header').addEventListener('click', () => switchPane('files'));
    document.getElementById('nw-git-panel-header').addEventListener('click', () => switchPane('git'));
    document.getElementById('nw-git-set-root-btn').addEventListener('click', (e) => { e.stopPropagation(); onSetGitRoot(); });
    document.getElementById('nw-git-refresh-btn').addEventListener('click', (e) => { e.stopPropagation(); loadGitStatus(); });
    document.getElementById('nw-git-filter-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleGitFilter(); });

    // ── Mobile sidebar toggles ──
    const sidebarOverlay = document.getElementById('nw-sidebar-overlay');
    const sidebar = document.getElementById('nw-sidebar');
    const sidebarToggle = document.getElementById('nw-sidebar-toggle');

    function toggleMobileSidebar() {
      const isOpen = sidebar.classList.toggle('nw-mobile-open');
      sidebarOverlay.classList.toggle('active', isOpen);
    }
    function closeMobileSidebar() {
      sidebar.classList.remove('nw-mobile-open');
      sidebarOverlay.classList.remove('active');
    }

    sidebarToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleMobileSidebar(); });
    sidebarOverlay.addEventListener('click', closeMobileSidebar);

    const gitSidebarOverlay = document.getElementById('nw-git-sidebar-overlay');
    const gitSidebar = document.getElementById('nw-git-sidebar');
    const gitSidebarToggle = document.getElementById('nw-git-sidebar-toggle');

    function toggleMobileGitSidebar() {
      const isOpen = gitSidebar.classList.toggle('nw-mobile-open');
      gitSidebarOverlay.classList.toggle('active', isOpen);
    }
    function closeMobileGitSidebar() {
      gitSidebar.classList.remove('nw-mobile-open');
      gitSidebarOverlay.classList.remove('active');
    }

    gitSidebarToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleMobileGitSidebar(); });
    gitSidebarOverlay.addEventListener('click', closeMobileGitSidebar);

    // Close mobile overlays when crossing the 768px boundary
    mobileResizeHandler = () => {
      if (window.innerWidth >= 768) {
        closeMobileSidebar();
        closeMobileGitSidebar();
      }
    };
    window.addEventListener('resize', mobileResizeHandler);

    // Tab keyboard shortcuts on the editor area
    const editorArea = document.getElementById('nw-editor-area');
    editorArea.addEventListener('keydown', onTabKeydown);

    loadSources();
  }

  // ─── Tab keyboard shortcuts ───

  function onTabKeydown(e) {
    // Ctrl+W / Cmd+W: close current tab
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
      if (activeTabIdx >= 0) {
        e.preventDefault();
        closeTab(activeTabIdx);
      }
      return;
    }

    // Ctrl+Tab: next tab
    if (e.ctrlKey && !e.shiftKey && e.key === 'Tab' && tabs.length > 1) {
      e.preventDefault();
      const next = (activeTabIdx + 1) % tabs.length;
      activateTab(next);
      return;
    }

    // Ctrl+Shift+Tab: previous tab
    if (e.ctrlKey && e.shiftKey && e.key === 'Tab' && tabs.length > 1) {
      e.preventDefault();
      const prev = (activeTabIdx - 1 + tabs.length) % tabs.length;
      activateTab(prev);
      return;
    }
  }

  // ─── Line Numbers ───

  function updateLineNumbers() {
    const editor = getActiveEditor();
    const gutter = document.getElementById('nw-line-numbers');
    if (!editor || !gutter) return;
    const lines = editor.value.split('\n').length;
    const cursorLine = getCurrentLine();
    let html = '';
    for (let i = 1; i <= lines; i++) {
      const cls = i === cursorLine ? ' class="nw-ln-active"' : '';
      html += `<div${cls}>${i}</div>`;
    }
    gutter.innerHTML = html;
    gutter.scrollTop = editor.scrollTop;
  }

  function syncLineNumbers(e) {
    const gutter = document.getElementById('nw-line-numbers');
    // Bound to each tab textarea's scroll event; the firing textarea is e.target.
    const editor = (e && e.target) || getActiveEditor();
    if (gutter && editor) gutter.scrollTop = editor.scrollTop;
  }

  function getCurrentLine() {
    const editor = getActiveEditor();
    if (!editor) return 1;
    const text = editor.value.substring(0, editor.selectionStart);
    return text.split('\n').length;
  }

  // ─── View switching is handled inside restoreTabState / onTogglePreview / resetEditor ──

  // ─── Markdown Rendering ───

  function parseMd(src) {
    src = (src || '').replace(/\r\n/g, '\n');

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    let html = '';
    const lines = src.split('\n');
    let i = 0;

    function collectList(startIdx, marker) {
      const items = [];
      let idx = startIdx;
      while (idx < lines.length) {
        const line = lines[idx];
        const m = marker === 'ul'
          ? line.match(/^(\s*)[*+-]\s+(.*)/)
          : line.match(/^(\s*)\d+[.)]\s+(.*)/);
        if (!m) break;
        items.push(m[2]);
        idx++;
      }
      return { items, end: idx };
    }

    while (i < lines.length) {
      const line = lines[i];

      // Blank line
      if (line.trim() === '') { i++; continue; }

      // Fenced code block
      const fenceMatch = line.match(/^(`{3,}|~{3,})\s*(.*)/);
      if (fenceMatch) {
        const fence = fenceMatch[1].charAt(0);
        const lang = escHtml(fenceMatch[2].trim());
        i++;
        let code = '';
        while (i < lines.length && !lines[i].startsWith(fence.repeat(fenceMatch[1].length))) {
          code += escHtml(lines[i]) + '\n';
          i++;
        }
        if (i < lines.length) i++;
        const langAttr = lang ? ` class="language-${lang}"` : '';
        html += `<pre><code${langAttr}>${code}</code></pre>\n`;
        continue;
      }

      // Heading
      const headMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headMatch) {
        const level = headMatch[1].length;
        html += `<h${level}>${inlineMd(headMatch[2])}</h${level}>\n`;
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }

      // Blockquote
      if (line.match(/^\s*>/)) {
        let bqLines = [];
        while (i < lines.length && (lines[i].match(/^\s*>/) || (lines[i].trim() !== '' && bqLines.length > 0 && !lines[i].match(/^#|^(\s*[-*_]\s*){3,}$|^```/)))) {
          bqLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += `<blockquote>${parseMd(bqLines.join('\n'))}</blockquote>\n`;
        continue;
      }

      // Unordered list
      if (line.match(/^\s*[*+-]\s+/)) {
        const { items, end } = collectList(i, 'ul');
        html += '<ul>\n' + items.map(t => `<li>${inlineMd(t)}</li>\n`).join('') + '</ul>\n';
        i = end;
        continue;
      }

      // Ordered list
      if (line.match(/^\s*\d+[.)]\s+/)) {
        const { items, end } = collectList(i, 'ol');
        html += '<ol>\n' + items.map(t => `<li>${inlineMd(t)}</li>\n`).join('') + '</ol>\n';
        i = end;
        continue;
      }

      // Table
      if (i + 1 < lines.length && lines[i + 1].match(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/)) {
        const headerCells = splitTableRow(line);
        const alignLine = lines[i + 1];
        const aligns = splitTableRow(alignLine).map(c => {
          c = c.trim();
          if (c.startsWith(':') && c.endsWith(':')) return 'center';
          if (c.endsWith(':')) return 'right';
          return 'left';
        });
        i += 2;
        let rows = '';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          const cells = splitTableRow(lines[i]);
          rows += '<tr>' + cells.map((c, ci) => `<td style="text-align:${aligns[ci] || 'left'}">${inlineMd(c.trim())}</td>`).join('') + '</tr>\n';
          i++;
        }
        html += `<table><thead><tr>` + headerCells.map((c, ci) => `<th style="text-align:${aligns[ci] || 'left'}">${inlineMd(c.trim())}</th>`).join('') + '</tr></thead><tbody>\n' + rows + '</tbody></table>\n';
        continue;
      }

      // Paragraph (collect consecutive non-blank lines)
      let para = '';
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,6}\s|```|~~~|>\s*|(\s*[-*_]\s*){3,}$|\s*[*+-]\s|\s*\d+[.)]\s)/)) {
        para += (para ? '\n' : '') + lines[i];
        i++;
      }
      if (para) html += `<p>${inlineMd(para)}</p>\n`;
    }

    return html;
  }

  function splitTableRow(line) {
    line = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return line.split('|');
  }

  function inlineMd(text) {
    let s = text;
    // Escape HTML
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Code spans (must be first to prevent inner processing)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Images
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Bold+italic
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    // Strikethrough
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Line break
    s = s.replace(/  \n/g, '<br>');
    return s;
  }

  function renderMarkdown(content) {
    const mdEl = document.getElementById('nw-markdown-preview');
    if (!mdEl) return;
    mdEl.innerHTML = parseMd(content);
  }

  // ─── Custom Root Operations ───

  async function onSetWorkspaceRoot() {
    if (!currentSource) return;
    const currentRoot = currentCustomWorkspaceRoot || (sourceList.find(s => s.key === currentSource)?.rootPath || '');
    const newRoot = prompt('Enter custom workspace root path:', currentRoot);
    if (newRoot === null) return;

    const trimmed = newRoot.trim();
    try {
      await Api.post(`${API}/custom-path`, {
        source: currentSource,
        workspaceRoot: trimmed || null,
        gitRoot: currentCustomGitRoot,
      });

      if (trimmed) {
        currentCustomWorkspaceRoot = trimmed;
      } else {
        currentCustomWorkspaceRoot = null;
      }

      // Refresh the source list to get updated info
      await loadSources();
      closeAllTabs();
      loadDir('');
      App.toast('Workspace root updated', 'ok');
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onSetGitRoot() {
    if (!currentSource) return;
    const currentRoot = currentCustomGitRoot || (sourceList.find(s => s.key === currentSource)?.gitRoot || '');
    const newRoot = prompt('Enter custom git root path (leave empty to use workspace root):', currentRoot);
    if (newRoot === null) return;

    const trimmed = newRoot.trim();
    try {
      await Api.post(`${API}/custom-path`, {
        source: currentSource,
        workspaceRoot: currentCustomWorkspaceRoot,
        gitRoot: trimmed || null,
      });

      if (trimmed) {
        currentCustomGitRoot = trimmed;
      } else {
        currentCustomGitRoot = null;
      }

      // Refresh git status if on git pane
      if (activePane === 'git') {
        gitLoaded = false;
        loadGitStatus();
      }
      App.toast('Git root updated', 'ok');
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  // ─── File Operations ───

  async function loadSources() {
    try {
      const data = await Api.get(`${API}/sources`);
      sourceList = data.sources || [];
      const sel = document.getElementById('nw-source-sel');
      sel.innerHTML = sourceList.map((s) =>
        `<option value="${esc(s.key)}"${s.key === currentSource ? ' selected' : ''}>${esc(s.label)}</option>`
      ).join('');
      if (!currentSource && sourceList.length > 0) {
        currentSource = sourceList[0].key;
      }
      // Load custom roots for current source
      if (currentSource) {
        const src = sourceList.find(s => s.key === currentSource);
        if (src) {
          currentCustomWorkspaceRoot = src.workspaceRoot !== src.rootPath ? src.workspaceRoot : null;
          currentCustomGitRoot = src.gitRoot || null;
        }
      }
      if (currentSource) loadDir('');
    } catch (err) {
      document.getElementById('nw-file-list').innerHTML = `<div style="padding:10px" class="text-dim">Error: ${esc(err.message)}</div>`;
    }
  }

  function onSourceChange(e) {
    currentSource = e.target.value;
    currentPath = '';

    // Load custom roots for new source
    const src = sourceList.find(s => s.key === currentSource);
    if (src) {
      currentCustomWorkspaceRoot = src.workspaceRoot !== src.rootPath ? src.workspaceRoot : null;
      currentCustomGitRoot = src.gitRoot || null;
    } else {
      currentCustomWorkspaceRoot = null;
      currentCustomGitRoot = null;
    }

    closeAllTabs();
    loadDir('');
    gitLoaded = false;
    gitFiles = [];
    selectedGitFile = null;
    if (activePane === 'git') loadGitStatus();
  }

  async function loadDir(relPath) {
    currentPath = relPath;
    const listEl = document.getElementById('nw-file-list');
    listEl.innerHTML = '<div style="padding:10px" class="text-dim">loading...</div>';
    renderBreadcrumb();

    try {
      const data = await Api.get(apiUrl('browse', { path: relPath }));
      renderFileList(data.items || []);
    } catch (err) {
      listEl.innerHTML = `<div style="padding:10px" class="text-dim">Error: ${esc(err.message)}</div>`;
    }
  }

  function renderBreadcrumb() {
    const el = document.getElementById('nw-breadcrumb');
    const parts = currentPath ? currentPath.split('/') : [];
    let html = `<a href="#" class="nw-bc-link" data-path="" style="color:var(--accent)">root</a>`;
    let acc = '';
    for (const p of parts) {
      acc += (acc ? '/' : '') + p;
      html += ` / <a href="#" class="nw-bc-link" data-path="${esc(acc)}" style="color:var(--accent)">${esc(p)}</a>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.nw-bc-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadDir(a.dataset.path);
      });
    });
  }

  function renderFileList(items) {
    const listEl = document.getElementById('nw-file-list');
    if (items.length === 0) {
      listEl.innerHTML = '<div style="padding:10px" class="text-dim">(empty)</div>';
      return;
    }

    // Collect paths of all open tabs for highlighting
    const openPaths = new Set(tabs.map(t => t.path));
    const curPath = openFilePath();

    let html = '';
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      html += `<div class="nw-file-item nw-dir-item" data-path="${esc(parent)}" data-isdir="1" style="padding:4px 10px;cursor:pointer;font-size:12px">
        <span class="text-dim">..</span>
      </div>`;
    }

    for (const item of items) {
      const icon = item.isDir ? '&#128193;' : '&#128196;';
      const protBadge = item.protected ? '<span style="color:var(--warning,#f0ad4e);font-size:9px;margin-left:4px" title="protected">&#9899;</span>' : '';
      const lockBadge = item.locked ? '<span style="color:var(--danger,#d9534f);font-size:9px;margin-left:4px" title="locked">&#128274;</span>' : '';
      const sizeStr = item.isDir ? '' : `<span class="text-dim" style="font-size:10px;margin-left:auto;padding-left:8px">${fmtSize(item.size)}</span>`;
      const canDelete = !item.protected && !item.locked;
      const deleteBtn = canDelete ? `<button class="nw-item-delete-btn" data-path="${esc(item.path)}" data-name="${esc(item.name)}" data-isdir="${item.isDir ? 1 : 0}" style="margin-left:auto;padding:0 4px;background:none;border:none;color:var(--text-dim,#8888aa);cursor:pointer;font-size:11px;opacity:0.6" title="Delete">&#10005;</button>` : '';
      const isOpen = openPaths.has(item.path);
      const isActive = isOpen && item.path === curPath;
      const activeStyle = isActive ? 'background:var(--bg-tertiary,#2a2a4a);' : isOpen ? 'background:rgba(255,255,255,0.015);' : '';
      html += `<div class="nw-file-item${item.isDir ? ' nw-dir-item' : ''}" data-path="${esc(item.path)}" data-isdir="${item.isDir ? 1 : 0}" style="padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;${activeStyle}">
        <span style="margin-right:6px">${icon}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</span>${protBadge}${lockBadge}${sizeStr}${deleteBtn}
      </div>`;
    }

    listEl.innerHTML = html;

    listEl.querySelectorAll('.nw-file-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Ignore clicks on the delete button
        if (e.target.classList.contains('nw-item-delete-btn')) return;
        const p = el.dataset.path;
        if (el.dataset.isdir === '1') {
          loadDir(p);
        } else {
          openFile(p);
        }
      });
      el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-tertiary,#2a2a4a)'; });
      el.addEventListener('mouseleave', () => {
        const isOpen = openPaths.has(el.dataset.path) && !el.dataset.isdir;
        const isActive = isOpen && el.dataset.path === openFilePath();
        if (!isActive) {
          el.style.background = isOpen ? 'rgba(255,255,255,0.015)' : '';
        }
      });
    });

    listEl.querySelectorAll('.nw-item-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemPath = btn.dataset.path;
        const itemName = btn.dataset.name;
        const isDir = btn.dataset.isdir === '1';
        if (confirm(`Delete ${isDir ? 'directory' : 'file'} "${itemName}"? This cannot be undone.`)) {
          isDir ? onDeleteDir(itemPath) : onFileDelete(itemPath);
        }
      });
    });
  }

  async function openFile(relPath, force = false) {
    closeMobileSidebars();

    // Check if tab already exists for this path
    const existingIdx = tabs.findIndex(t => t.path === relPath);
    const currentTab = activeTab();

    if (existingIdx !== -1 && !force) {
      // Tab exists — activate it (prompt if current is dirty and switching away)
      if (currentTab && currentTab.dirty && existingIdx !== activeTabIdx) {
        if (!confirm('Unsaved changes will be lost. Continue?')) return;
      }
      activateTab(existingIdx);
      return;
    }

    // Opening a new file while current tab is dirty
    if (currentTab && currentTab.dirty && existingIdx !== activeTabIdx) {
      if (!force && !confirm('Unsaved changes will be lost. Continue?')) return;
    }

    if (isImageFile(relPath)) {
      // Save current tab state (cursor/scroll capture) before creating new tab
      saveCurrentTabState();

      const tabIdx = getOrCreateTab(relPath);
      const tab = tabs[tabIdx];
      tab.viewMode = 'image';
      tab.dirty = false;
      tab.mdPreviewMode = false;
      tab.originalContent = '';
      tab.content = '';
      // Hide the textarea (created by getOrCreateTab) for image view
      if (tab._textarea) tab._textarea.style.display = 'none';

      const rawUrl = apiUrl('raw', { path: relPath });
      tab.imageDataUrl = rawUrl;

      const imgEl = document.getElementById('nw-image-el');
      imgEl.src = '';
      imgEl.src = rawUrl;
      imgEl.onload = () => {
        document.getElementById('nw-status-lines').textContent = `${imgEl.naturalWidth} x ${imgEl.naturalHeight}`;
      };
      imgEl.onerror = () => {
        document.getElementById('nw-status-lines').textContent = 'failed to load';
      };

      // Delegate toolbar/status-bar UI to restoreTabState for consistency
      activeTabIdx = tabIdx;
      restoreTabState(tabIdx);

      // Override status-size/modified using item metadata (not available synchronously)
      try {
        const data = await Api.get(apiUrl('browse', { path: currentPath }));
        const item = (data.items || []).find((i) => i.path === relPath);
        if (item) {
          tab.size = item.size;
          tab.modified = item.modified;
          tab.protected = item.protected || false;
          tab.locked = item.locked || false;
          document.getElementById('nw-status-size').textContent = fmtSize(item.size);
          document.getElementById('nw-status-modified').textContent = fmtDate(item.modified);
          document.getElementById('nw-status-protected').textContent = tab.protected ? '[protected]' : '';
          document.getElementById('nw-status-protected').style.color = tab.protected ? 'var(--warning,#f0ad4e)' : '';
          if (tab.protected || tab.locked) {
            document.getElementById('nw-rename-btn').disabled = true;
            document.getElementById('nw-delete-btn').disabled = true;
          }
          renderTabBar();
        }
      } catch { /* best-effort */ }

      loadDir(currentPath);
      return;
    }

    try {
      // Save current tab cursor/scroll before fetching new file
      saveCurrentTabState();

      const data = await Api.get(apiUrl('file', { path: relPath }));

      const tabIdx = getOrCreateTab(relPath);
      const tab = tabs[tabIdx];
      tab.path = data.path;
      tab.originalContent = data.content;
      tab.content = data.content;
      tab.dirty = false;
      tab.locked = data.locked || false;
      tab.protected = data.protected || false;
      tab.size = data.size;
      tab.modified = data.modified;
      tab.cursorStart = 0;
      tab.cursorEnd = 0;
      tab.scrollPos = 0;

      const isMd = isMarkdownFile(relPath);
      tab.mdPreviewMode = isMd;
      tab.viewMode = isMd ? 'markdown' : 'editor';

      // Populate the per-tab textarea and apply locked state
      if (tab._textarea) {
        tab._textarea.value = data.content;
        tab._textarea.disabled = !!data.locked;
      }

      // Delegate toolbar/status-bar/visibility UI to restoreTabState
      activeTabIdx = tabIdx;
      restoreTabState(tabIdx);

      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  // ─── Toolbar Actions ───

  function onClose() {
    if (activeTabIdx < 0) return;
    closeTab(activeTabIdx);
  }

  function onRefresh() {
    const tab = activeTab();
    if (!tab) return;
    if (tab.dirty && !confirm('You have unsaved changes. Reload from disk?')) return;
    openFile(tab.path, true);
  }

  function onTogglePreview() {
    const tab = activeTab();
    if (!tab || !isMarkdownFile(tab.path)) return;
    const btn = document.getElementById('nw-preview-btn');

    if (tab.mdPreviewMode) {
      tab.mdPreviewMode = false;
      tab.viewMode = 'editor';
      // Show this tab's textarea; hide markdown preview
      if (tab._textarea) tab._textarea.style.display = '';
      document.getElementById('nw-markdown-preview').style.display = 'none';
      document.getElementById('nw-line-numbers').style.display = '';
      btn.textContent = 'preview';
      updateLineNumbers();
      updateCursorPos();
    } else {
      tab.mdPreviewMode = true;
      tab.viewMode = 'markdown';
      saveCurrentTabState();
      // Use the active tab's textarea (markdown render source) — fall back to tab.content
      const sourceValue = tab._textarea ? tab._textarea.value : tab.content;
      renderMarkdown(sourceValue);
      // Hide this tab's textarea; show markdown preview
      if (tab._textarea) tab._textarea.style.display = 'none';
      document.getElementById('nw-markdown-preview').style.display = '';
      document.getElementById('nw-line-numbers').style.display = 'none';
      btn.textContent = 'edit';
    }
  }

  // ─── Editor Events ───

  function onEditorInput(e) {
    // Use the firing textarea, not activeTab() — guards against late input events
    // firing after activeTabIdx has changed.
    const editor = (e && e.target) || getActiveEditor();
    const tab = activeTab();
    if (!editor || !tab || tab.viewMode !== 'editor' || editor !== tab._textarea) return;
    const isDirty = editor.value !== tab.originalContent;
    if (isDirty !== tab.dirty) {
      tab.dirty = isDirty;
      document.getElementById('nw-dirty-badge').style.display = tab.dirty ? 'inline' : 'none';
    }
    tab.content = editor.value;
    document.getElementById('nw-status-lines').textContent = `${editor.value.split('\n').length} lines`;
    updateCursorPos();
    updateLineNumbers();
    renderTabBar(); // update dirty indicator on tab
  }

  function onEditorKeydown(e) {
    const editor = e.target;
    const tab = activeTab();

    // Tab: indent
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = start + 2;
      onEditorInput();
      return;
    }

    // Shift+Tab: dedent
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const start = editor.selectionStart;
      const val = editor.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineText = val.substring(lineStart, start);
      const leadingSpaces = lineText.match(/^ {1,2}/);
      if (leadingSpaces) {
        const removed = leadingSpaces[0].length;
        editor.value = val.substring(0, lineStart) + val.substring(lineStart + removed);
        editor.selectionStart = editor.selectionEnd = start - removed;
        onEditorInput();
      }
      return;
    }

    // Enter: auto-indent
    if (e.key === 'Enter') {
      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const val = editor.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const currentLine = val.substring(lineStart, start);
      const indent = currentLine.match(/^(\s*)/)[1];
      const trimmedEnd = currentLine.trimEnd();
      const extraIndent = (trimmedEnd.endsWith('{') || trimmedEnd.endsWith('[') || trimmedEnd.endsWith(':')) ? '  ' : '';
      const insertion = '\n' + indent + extraIndent;
      editor.value = val.substring(0, start) + insertion + val.substring(end);
      editor.selectionStart = editor.selectionEnd = start + insertion.length;
      onEditorInput();
      return;
    }

    // Ctrl+S: save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (!document.getElementById('nw-save-btn').disabled) onSave();
      return;
    }

    // Ctrl+D: duplicate line
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      const start = editor.selectionStart;
      const val = editor.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = val.indexOf('\n', start);
      const end = lineEnd === -1 ? val.length : lineEnd;
      const line = val.substring(lineStart, end);
      editor.value = val.substring(0, end) + '\n' + line + val.substring(end);
      editor.selectionStart = editor.selectionEnd = start + line.length + 1;
      onEditorInput();
      return;
    }

    // Ctrl+/: toggle comment
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      if (!tab) return;
      const ext = getFileExt(tab.path);
      const prefix = COMMENT_MAP[ext];
      if (!prefix) return;

      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const val = editor.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = val.indexOf('\n', end);
      const blockEnd = lineEnd === -1 ? val.length : lineEnd;

      const lines = val.substring(lineStart, blockEnd).split('\n');
      const allCommented = lines.every((l) => l.trimStart().startsWith(prefix));

      let newLines;
      if (allCommented) {
        newLines = lines.map((l) => {
          const idx = l.indexOf(prefix);
          const after = l.substring(idx + prefix.length);
          return l.substring(0, idx) + (after.startsWith(' ') ? after.substring(1) : after);
        });
      } else {
        newLines = lines.map((l) => {
          const match = l.match(/^(\s*)/);
          const ws = match ? match[1] : '';
          return ws + prefix + ' ' + l.substring(ws.length);
        });
      }

      const replacement = newLines.join('\n');
      editor.value = val.substring(0, lineStart) + replacement + val.substring(blockEnd);
      editor.selectionStart = lineStart;
      editor.selectionEnd = lineStart + replacement.length;
      onEditorInput();
      return;
    }
  }

  function updateCursorPos() {
    const editor = getActiveEditor();
    if (!editor) {
      document.getElementById('nw-cursor-pos').textContent = '';
      return;
    }
    const pos = editor.selectionStart;
    const text = editor.value.substring(0, pos);
    const line = text.split('\n').length;
    const col = pos - text.lastIndexOf('\n');
    document.getElementById('nw-cursor-pos').textContent = `Ln ${line}, Col ${col}`;
    updateLineNumbers();
  }

  function onWrapToggle(e) {
    // Apply to every open tab's textarea so the setting is preserved on switch
    const ws = e.target.checked ? 'pre-wrap' : 'pre';
    const ox = e.target.checked ? 'hidden' : 'auto';
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (t._textarea) {
        t._textarea.style.whiteSpace = ws;
        t._textarea.style.overflowX = ox;
      }
    }
  }

  async function onSave() {
    const tab = activeTab();
    if (!tab || !tab.dirty) return;
    const editor = tab._textarea;
    if (!editor) return;
    try {
      await Api.put(apiUrl('file'), { path: tab.path, content: editor.value });
      tab.originalContent = editor.value;
      tab.content = editor.value;
      tab.dirty = false;
      document.getElementById('nw-dirty-badge').style.display = 'none';
      if (tab.mdPreviewMode) renderMarkdown(editor.value);
      renderTabBar();
      App.toast('saved', 'ok');
    } catch (err) {
      App.toast(`Save failed: ${err.message}`, 'err');
    }
  }

  function onRevert() {
    const tab = activeTab();
    if (!tab) return;
    if (tab.dirty && !confirm('Revert unsaved changes?')) return;
    openFile(tab.path, true);
  }

  async function onNewFile() {
    const name = prompt(`New file path (relative to ${currentPath || 'root'}):`);
    if (!name) return;
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await Api.post(apiUrl('file'), { path: fullPath, content: '' });
      App.toast('created', 'ok');
      loadDir(currentPath);
      openFile(fullPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onNewDir() {
    const name = prompt(`New directory path (relative to ${currentPath || 'root'}):`);
    if (!name) return;
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await Api.post(apiUrl('mkdir'), { path: fullPath });
      App.toast('directory created', 'ok');
      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onRename() {
    const tab = activeTab();
    if (!tab) return;
    const newName = prompt('New path:', tab.path);
    if (!newName || newName === tab.path) return;
    try {
      await Api.post(apiUrl('rename'), { oldPath: tab.path, newPath: newName });
      App.toast('renamed', 'ok');
      tab.path = newName;
      document.getElementById('nw-file-label').textContent = newName;
      renderTabBar();
      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onDelete() {
    const tab = activeTab();
    if (!tab) return;
    if (!confirm(`Delete "${tab.path}"? This cannot be undone.`)) return;
    try {
      await Api.delete(apiUrl('file', { path: tab.path }));
      App.toast('deleted', 'ok');
      // Remove this tab (no dirty check — user already confirmed)
      const idx = activeTabIdx;
      removeTextareaForTab(tab);
      tabs.splice(idx, 1);
      if (tabs.length === 0) {
        activeTabIdx = -1;
        resetEditor();
      } else {
        const next = Math.min(idx, tabs.length - 1);
        restoreTabState(next);
      }
      renderTabBar();
      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onDeleteDir(relPath) {
    if (!relPath) return;
    try {
      await Api.delete(apiUrl('dir', { path: relPath }));
      App.toast('directory deleted', 'ok');
      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  async function onFileDelete(relPath) {
    if (!relPath) return;
    try {
      await Api.delete(apiUrl('file', { path: relPath }));
      App.toast('deleted', 'ok');
      // If file is open in a tab, close it
      const tabIdx = tabs.findIndex(t => t.path === relPath);
      if (tabIdx !== -1) {
        const closingTab = tabs[tabIdx];
        removeTextareaForTab(closingTab);
        tabs.splice(tabIdx, 1);
        if (tabIdx <= activeTabIdx) activeTabIdx = Math.max(0, activeTabIdx - 1);
        if (tabs.length === 0) { activeTabIdx = -1; resetEditor(); }
        else { restoreTabState(Math.min(activeTabIdx, tabs.length - 1)); }
        renderTabBar();
      }
      loadDir(currentPath);
    } catch (err) {
      App.toast(`Error: ${err.message}`, 'err');
    }
  }

  // ─── Accordion ───

  function switchPane(pane) {
    if (pane === activePane) return;
    activePane = pane;
    document.getElementById('nw-files-panel').classList.toggle('active', pane === 'files');
    document.getElementById('nw-git-panel').classList.toggle('active', pane === 'git');
    if (pane === 'git' && !gitLoaded) {
      loadGitStatus();
    }
  }

  // ─── Git Functions ───

  function toggleGitFilter() {
    gitShowStaged = !gitShowStaged;
    const btn = document.getElementById('nw-git-filter-btn');
    if (gitShowStaged) {
      btn.textContent = 'staged';
    } else {
      btn.textContent = 'all';
    }
    renderGitFileList();
  }

  async function loadGitStatus() {
    try {
      const params = {};
      if (currentCustomGitRoot) {
        params.gitRoot = currentCustomGitRoot;
      }
      const url = apiUrl('git/status', params);
      const data = await Api.get(url);
      gitIsRepo = data.isGitRepo;
      gitBranch = data.branch;
      gitFiles = data.files || [];
      gitLoaded = true;
      selectedGitFile = null;

      const branchEl = document.getElementById('nw-git-branch');
      if (gitIsRepo) {
        branchEl.innerHTML = `<span style="color:var(--accent-green)">⎇</span> ${esc(gitBranch || 'HEAD')}`;
      } else {
        branchEl.textContent = 'not a git repo';
      }

      const countEl = document.getElementById('nw-git-count');
      if (gitIsRepo && gitFiles.length > 0) {
        countEl.textContent = `(${gitFiles.length})`;
        countEl.style.color = 'var(--accent-amber,#ffaa00)';
      } else {
        countEl.textContent = '';
      }

      renderGitFileList();
      document.getElementById('nw-git-diff-content').textContent = '';
      document.getElementById('nw-git-diff-label').textContent = 'select a file to view diff';
    } catch (err) {
      App.toast(`Git error: ${err.message}`, 'err');
    }
  }

  function renderGitFileList() {
    const container = document.getElementById('nw-git-file-list');

    if (!gitIsRepo) {
      container.innerHTML = '<div style="padding:20px 10px;color:var(--text-dim);text-align:center">Not a git repository</div>';
      return;
    }

    let filtered = gitFiles;
    if (gitShowStaged) {
      filtered = gitFiles.filter((f) => f.staged);
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding:20px 10px;color:var(--text-dim);text-align:center">No changes detected</div>';
      return;
    }

    let html = '';
    for (const file of filtered) {
      const badgeLetter = file.status === 'untracked' ? 'U'
        : file.status === 'modified' ? 'M'
        : file.status === 'added' ? 'A'
        : file.status === 'deleted' ? 'D'
        : file.status === 'renamed' ? 'R' : '?';
      const badgeClass = file.status === 'untracked' ? 'nw-git-badge-u'
        : file.status === 'modified' ? 'nw-git-badge-m'
        : file.status === 'added' ? 'nw-git-badge-a'
        : file.status === 'deleted' ? 'nw-git-badge-d'
        : file.status === 'renamed' ? 'nw-git-badge-r' : 'nw-git-badge-m';
      const stagedTag = file.staged ? '<span style="font-size:9px;color:var(--accent-green);margin-left:auto">staged</span>' : '';
      const sel = (selectedGitFile && selectedGitFile.path === file.path && selectedGitFile.staged === file.staged) ? ' selected' : '';
      html += `<div class="nw-git-file${sel}" data-path="${esc(file.path)}" data-staged="${file.staged ? '1' : '0'}" data-untracked="${file.status === 'untracked' ? '1' : '0'}">
        <span class="nw-git-badge ${badgeClass}">${badgeLetter}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${esc(file.path)}">${esc(file.path)}</span>
        ${stagedTag}
      </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.nw-git-file').forEach((el) => {
      el.addEventListener('click', () => {
        const filePath = el.dataset.path;
        const staged = el.dataset.staged === '1';
        const untracked = el.dataset.untracked === '1';
        loadGitDiff(filePath, staged, untracked);
      });
    });
  }

  async function loadGitDiff(filePath, staged, untracked) {
    selectedGitFile = { path: filePath, staged };
    renderGitFileList();

    const label = document.getElementById('nw-git-diff-label');
    const content = document.getElementById('nw-git-diff-content');
    label.textContent = filePath + (staged ? ' (staged)' : '');

    try {
      const params = { path: filePath };
      if (staged) params.staged = '1';
      if (untracked) params.untracked = '1';
      if (currentCustomGitRoot) params.gitRoot = currentCustomGitRoot;
      const url = apiUrl('git/diff', params);
      const data = await Api.get(url);

      if (data.error) {
        content.textContent = data.error;
        return;
      }

      if (!data.diff) {
        content.textContent = '(no diff available)';
        return;
      }

      content.innerHTML = renderDiffHtml(data.diff);
    } catch (err) {
      content.textContent = `Error: ${err.message}`;
    }
  }

  function renderDiffHtml(diff) {
    const lines = diff.split('\n');
    let html = '';
    for (const line of lines) {
      const escaped = esc(line);
      if (line.startsWith('@@')) {
        html += `<span class="nw-diff-hunk">${escaped}</span>\n`;
      } else if (line.startsWith('+')) {
        html += `<span class="nw-diff-add">${escaped}</span>\n`;
      } else if (line.startsWith('-')) {
        html += `<span class="nw-diff-del">${escaped}</span>\n`;
      } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file')) {
        html += `<span class="nw-diff-header">${escaped}</span>\n`;
      } else {
        html += escaped + '\n';
      }
    }
    return html;
  }

  function destroy() {
    tabs.forEach(removeTextareaForTab);
    tabs = [];
    activeTabIdx = -1;
    if (mobileResizeHandler) {
      window.removeEventListener('resize', mobileResizeHandler);
      mobileResizeHandler = null;
    }
  }

  return { render, destroy };
})();
