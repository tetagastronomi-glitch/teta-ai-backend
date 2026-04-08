/**
 * mobile-nav.js — Hamburger menu + bottom nav for all dashboard pages
 * Include via <script src="/js/mobile-nav.js"></script> before </body>
 */
(function () {
  if (window.__mobileNavLoaded) return;
  window.__mobileNavLoaded = true;

  // Detect current page
  var path = location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'dashboard';

  // Bottom nav items (core navigation — always visible)
  var tabs = [
    { id: 'dashboard',  icon: '\uD83D\uDCC5', label: 'Home',     href: '/dashboard' },
    { id: 'guests',     icon: '\uD83D\uDC65', label: 'Guests',   href: '/guests' },
    { id: 'messages',   icon: '\uD83D\uDCAC', label: 'Messages', href: '/messages' },
    { id: 'analytics',  icon: '\uD83D\uDCCA', label: 'Analytics', href: '/analytics' },
    { id: 'settings',   icon: '\u2699\uFE0F', label: 'Settings', href: '/settings' }
  ];

  // ── Inject CSS ──────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.mob-hamburger{display:none;background:none;border:none;color:var(--text);font-size:24px;cursor:pointer;padding:6px;border-radius:8px;transition:all 0.2s;line-height:1;z-index:60}',
    '.mob-hamburger:hover{background:var(--surface2)}',
    '.mob-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:45;opacity:0;transition:opacity 0.3s}',
    '.mob-overlay.open{opacity:1}',
    '.sidebar.mob-open{transform:translateX(0) !important}',
    '.mob-bottom{display:none;position:fixed;bottom:0;left:0;right:0;z-index:50;background:var(--bg2,#0F0F12);border-top:1px solid var(--border,rgba(255,255,255,0.06));padding:6px 0 env(safe-area-inset-bottom,6px)}',
    '.mob-bottom-inner{display:flex;justify-content:space-around;align-items:center}',
    '.mob-tab{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 8px;border-radius:10px;text-decoration:none;color:var(--text3,rgba(255,255,255,0.3));font-size:10px;font-weight:600;transition:all 0.2s;border:none;background:none;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent}',
    '.mob-tab-icon{font-size:20px;line-height:1}',
    '.mob-tab.active{color:var(--amber,#F59E0B)}',
    '.mob-tab:hover{color:var(--text2,rgba(255,255,255,0.5))}',
    '@media(max-width:768px){',
    '  .mob-hamburger{display:flex}',
    '  .mob-bottom{display:block}',
    '  .sidebar{transform:translateX(-100%) !important;display:flex !important;transition:transform 0.3s ease !important}',
    '  .main{margin-left:0 !important}',
    '  .content{padding-bottom:80px !important}',
    '  .jerry-fab{bottom:80px !important}',
    '  .topbar{padding:0 16px !important}',
    '  .stats-grid{grid-template-columns:repeat(2,1fr) !important}',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  // ── Hamburger button ────────────────────────────────────────
  var hamburger = document.createElement('button');
  hamburger.className = 'mob-hamburger';
  hamburger.innerHTML = '\u2630';
  hamburger.setAttribute('aria-label', 'Open menu');

  var topbar = document.querySelector('.topbar-left') || document.querySelector('.topbar');
  if (topbar) {
    if (topbar.classList.contains('topbar-left')) {
      topbar.insertBefore(hamburger, topbar.firstChild);
    } else {
      topbar.prepend(hamburger);
    }
  }

  // ── Overlay ─────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.className = 'mob-overlay';
  document.body.appendChild(overlay);

  var sidebar = document.querySelector('.sidebar');

  function openMenu() {
    if (!sidebar) return;
    sidebar.classList.add('mob-open');
    overlay.style.display = 'block';
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    hamburger.innerHTML = '\u2715';
  }

  function closeMenu() {
    if (!sidebar) return;
    sidebar.classList.remove('mob-open');
    overlay.classList.remove('open');
    setTimeout(function () { overlay.style.display = 'none'; }, 300);
    hamburger.innerHTML = '\u2630';
  }

  hamburger.addEventListener('click', function () {
    sidebar && sidebar.classList.contains('mob-open') ? closeMenu() : openMenu();
  });
  overlay.addEventListener('click', closeMenu);

  // Close sidebar when a nav item is clicked (mobile)
  if (sidebar) {
    sidebar.querySelectorAll('.nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        if (window.innerWidth <= 768) closeMenu();
      });
    });
  }

  // ── Bottom nav ──────────────────────────────────────────────
  var bottom = document.createElement('nav');
  bottom.className = 'mob-bottom';
  var inner = document.createElement('div');
  inner.className = 'mob-bottom-inner';

  tabs.forEach(function (tab) {
    var a = document.createElement('a');
    a.className = 'mob-tab' + (path === tab.id ? ' active' : '');
    a.href = tab.href;
    a.innerHTML = '<span class="mob-tab-icon">' + tab.icon + '</span>' + tab.label;
    inner.appendChild(a);
  });

  bottom.appendChild(inner);
  document.body.appendChild(bottom);
})();
