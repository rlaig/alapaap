'use strict';

// Central bridge: resolves the CSS custom-property tokens defined in
// style.css (:root) to concrete values. Intended ONLY for the few third-party
// libs (xterm, charts) that need an actual color value rather than a token
// reference. Everything else should reference tokens directly in CSS/inline.
//
// Read once at load; the app is a static dark theme with no runtime switching.
const THEME = (() => {
  const cs = getComputedStyle(document.documentElement);
  const get = (name) => cs.getPropertyValue(name).trim();
  return {
    // surfaces
    bgPrimary:   get('--bg-primary'),
    bgPanel:     get('--bg-panel'),
    bgSecondary: get('--bg-secondary'),
    bgTertiary:  get('--bg-tertiary'),
    bgInput:     get('--bg-input'),
    // text + borders
    textBright:  get('--text-bright'),
    textDim:     get('--text-dim'),
    textMuted:   get('--text-muted'),
    border:      get('--border'),
    // accent palette
    green:       get('--accent-green'),
    amber:       get('--accent-amber'),
    red:         get('--accent-red'),
    blue:        get('--accent-blue'),
    purple:      get('--accent-purple'),
    pink:        get('--accent-pink'),
    mint:        get('--accent-mint'),
    // semantic layer
    success:     get('--success'),
    warning:     get('--warning'),
    danger:      get('--danger'),
    info:        get('--info'),
    // type
    fontMono:    get('--font-mono'),
  };
})();
