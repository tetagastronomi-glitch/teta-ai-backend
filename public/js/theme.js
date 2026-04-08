/* ═══════════════════════════════════════════════════════════════
   TE TA AI — Theme Toggle (Dark/Light)
   Include this on every page. Auto-creates toggle button.
   ═══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var STORAGE_KEY = 'tta_theme';
  var DEFAULT_THEME = 'dark';

  // Get saved or default theme
  function getTheme() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME; }
    catch(e) { return DEFAULT_THEME; }
  }

  // Apply theme to document
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch(e) {}
    updateToggleIcon(theme);
    updateMetaTheme(theme);
  }

  // Update meta theme-color
  function updateMetaTheme(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#09090B' : '#FAFAF8');
  }

  // Update toggle button icon
  function updateToggleIcon(theme) {
    var btn = document.getElementById('tt-theme-toggle');
    if (!btn) return;
    btn.innerHTML = theme === 'dark'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  // Toggle between dark and light
  function toggle() {
    var current = document.documentElement.getAttribute('data-theme') || getTheme();
    var next = current === 'dark' ? 'light' : 'dark';
    document.body.classList.add('theme-transitioning');
    applyTheme(next);
    setTimeout(function() {
      document.body.classList.remove('theme-transitioning');
    }, 350);
  }

  // Initialize the toggle button (use existing in-page element or create fixed fallback)
  function createToggle() {
    var existing = document.getElementById('tt-theme-toggle');
    if (existing) {
      // Button already in HTML (e.g., in navbar) — just wire up the icon
      existing.addEventListener('click', toggle);
      updateToggleIcon(getTheme());
      return;
    }

    // Fallback: create a fixed-position toggle (for pages without one in the markup)
    var btn = document.createElement('button');
    btn.id = 'tt-theme-toggle';
    btn.setAttribute('aria-label', 'Toggle theme');
    btn.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:999;' +
      'width:40px;height:40px;border-radius:10px;border:1px solid var(--border);' +
      'background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'color:var(--text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      'transition:all 0.2s ease;padding:0;';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    updateToggleIcon(getTheme());
  }

  // Apply theme BEFORE paint (prevent flash)
  applyTheme(getTheme());

  // Create toggle on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createToggle);
  } else {
    createToggle();
  }

  // Expose globally
  window.ttTheme = {
    toggle: toggle,
    get: getTheme,
    set: applyTheme
  };
})();
