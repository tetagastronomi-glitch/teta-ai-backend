(function () {
  if (window.__ownerShellLoaded) return;
  window.__ownerShellLoaded = true;

  // ─── Inject shared light-mode CSS patch (idempotent) ───────────────────
  if (!document.getElementById('owner-light-css')) {
    var lightLink = document.createElement('link');
    lightLink.id = 'owner-light-css';
    lightLink.rel = 'stylesheet';
    lightLink.href = '/css/owner-light.css';
    document.head.appendChild(lightLink);
  }

  // page slug ↔ pathname (slug = the FEATURE_PLANS key in license.js)
  var ownerPages = {
    '/dashboard': 'dashboard',
    '/analytics': 'analytics',
    '/guests': 'guests',
    '/messages': 'messages',
    '/settings': 'settings',
    '/campaigns': 'campaigns',
    '/menu': 'menu',
    '/floorplan': 'floorplan',
    '/waitlist': 'waitlist',
    '/ai-waiter': 'ai-waiter'
  };
  if (!(location.pathname in ownerPages)) return;

  var sidebar = document.querySelector('.sidebar');
  var sidebarNav = document.querySelector('.sidebar-nav');
  if (!sidebar || !sidebarNav) return;

  var sections = [
    {
      titleKey: 'nav_section.restaurant',
      fallback: 'Restaurant',
      items: [
        { href: '/dashboard', slug: 'dashboard', icon: '📋', key: 'nav.dashboard', fallback: 'Dashboard' },
        { href: '/analytics', slug: 'analytics', icon: '📊', key: 'nav.analytics', fallback: 'Analytics' },
        { href: '/guests', slug: 'guests', icon: '👥', key: 'nav.guests', fallback: 'Guests' },
        { href: '/messages', slug: 'messages', icon: '💬', key: 'nav.messages', fallback: 'Messages' }
      ]
    },
    {
      titleKey: 'nav_section.operations',
      fallback: 'Operations',
      items: [
        { href: '/floorplan', slug: 'floorplan', icon: '🗺️', key: 'nav.floor_plan', fallback: 'Floor Plan' },
        { href: '/menu', slug: 'menu', icon: '🍽️', key: 'nav.menu', fallback: 'Menu' },
        { href: '/waitlist', slug: 'waitlist', icon: '⏳', key: 'nav.waitlist', fallback: 'Waitlist' },
        { href: '/ai-waiter', slug: 'ai-waiter', icon: '🤖', key: 'nav.ai_waiter', fallback: 'AI Waiter' }
      ]
    },
    {
      titleKey: 'nav_section.marketing',
      fallback: 'Marketing',
      items: [
        { href: '/campaigns', slug: 'campaigns', icon: '📣', key: 'nav.campaigns', fallback: 'Campaigns' }
      ]
    },
    {
      titleKey: 'nav_section.system',
      fallback: 'System',
      items: [
        { href: '/settings', slug: 'settings', icon: '⚙️', key: 'nav.settings', fallback: 'Settings' }
      ]
    }
  ];

  // ─── Plan / feature gating state ───────────────────────────────────────
  var licenseState = {
    plan: null,
    planLabel: 'Starter',
    pages: null,            // { slug: bool }
    upgradeUrls: { pro: '', enterprise: '' },
    loaded: false
  };

  function translate(key, fallback) {
    return typeof window.t === 'function' ? window.t(key, fallback) : fallback;
  }

  function isPageLocked(slug) {
    if (!licenseState.loaded) return false;          // assume unlocked until we know
    if (!licenseState.pages) return false;
    return licenseState.pages[slug] === false;
  }

  function planNeededFor(slug) {
    // Pro unlocks: analytics, floorplan, menu, waitlist (in addition to starter set)
    var proPages = ['analytics', 'floorplan', 'menu', 'waitlist'];
    if (proPages.indexOf(slug) !== -1) return 'pro';
    // Everything else locked → enterprise
    return 'enterprise';
  }

  function renderSidebar() {
    sidebarNav.innerHTML = sections.map(function (section) {
      var items = section.items.map(function (item) {
        var locked = isPageLocked(item.slug);
        var active = location.pathname === item.href ? ' active' : '';
        var lockedCls = locked ? ' locked' : '';
        var icon = locked ? '🔒' : item.icon;
        var dataAttr = ' data-slug="' + item.slug + '"';
        var href = locked ? 'javascript:void(0)' : item.href;
        return (
          '<a class="nav-item' + active + lockedCls + '" href="' + href + '"' + dataAttr + '>' +
            '<span class="ico">' + icon + '</span>' +
            '<span data-i18n="' + item.key + '">' + translate(item.key, item.fallback) + '</span>' +
          '</a>'
        );
      }).join('');

      return (
        '<div class="nav-sec" data-i18n="' + section.titleKey + '">' + translate(section.titleKey, section.fallback) + '</div>' +
        items
      );
    }).join('');

    // Wire locked-item clicks → upgrade modal
    sidebarNav.querySelectorAll('.nav-item.locked').forEach(function (el) {
      el.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var slug = el.getAttribute('data-slug');
        var label = el.querySelector('[data-i18n]')?.textContent || slug;
        openUpgradeModal(slug, label);
      });
    });

    if (typeof window.applyI18n === 'function') window.applyI18n();
  }

  function ensureStyles() {
    if (document.getElementById('owner-shell-styles')) return;
    var style = document.createElement('style');
    style.id = 'owner-shell-styles';
    style.textContent = [
      '.nav-sec{padding:16px 12px 8px;font:700 10px var(--mono,"JetBrains Mono",monospace);text-transform:uppercase;letter-spacing:0.08em;color:rgba(250,250,250,0.34)}',
      '.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;color:rgba(250,250,250,0.68);font-weight:600;transition:0.18s ease;border:1px solid transparent}',
      '.nav-item:hover{background:rgba(255,255,255,0.05);color:#FAFAFA}',
      '.nav-item.active{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.18);color:#FCD38D}',
      '.nav-item .ico{width:20px;text-align:center;opacity:0.8}',
      '.nav-item.locked{opacity:0.3;cursor:not-allowed}',
      '.nav-item.locked:hover{opacity:0.5;background:rgba(255,255,255,0.04);color:rgba(250,250,250,0.68)}',
      '.nav-item.locked .ico{opacity:1}',
      // Upgrade modal
      '.tt-upg-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}',
      '.tt-upg-overlay.show{display:flex}',
      '.tt-upg-card{width:min(520px,100%);background:#101014;border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:32px;color:#FAFAFA;font-family:var(--font,"Plus Jakarta Sans",sans-serif);box-shadow:0 32px 80px rgba(0,0,0,0.6)}',
      '.tt-upg-icon{width:56px;height:56px;border-radius:18px;background:linear-gradient(135deg,#F59E0B,#D97706);display:grid;place-items:center;font-size:26px;margin-bottom:18px}',
      '.tt-upg-card h3{font-size:1.5rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px}',
      '.tt-upg-card p{color:rgba(250,250,250,0.66);line-height:1.6;font-size:0.95rem;margin-bottom:22px}',
      '.tt-upg-card p strong{color:#FCD38D}',
      '.tt-upg-actions{display:flex;flex-direction:column;gap:10px}',
      '.tt-upg-btn{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#FAFAFA;font-weight:700;text-decoration:none;transition:0.2s ease;cursor:pointer}',
      '.tt-upg-btn:hover{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.18);transform:translateY(-1px)}',
      '.tt-upg-btn.primary{border:0;background:linear-gradient(135deg,#F59E0B,#D97706);color:#111}',
      '.tt-upg-btn .price{font-family:var(--mono,"JetBrains Mono",monospace);font-size:0.88rem;opacity:0.8}',
      '.tt-upg-btn.primary .price{opacity:1}',
      '.tt-upg-close{margin-top:18px;width:100%;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.08);background:transparent;color:rgba(250,250,250,0.5);font-weight:600;cursor:pointer}',
      '.tt-upg-close:hover{color:#FAFAFA}',
      // Mobile shell (existing styles)
      '.owner-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.64);backdrop-filter:blur(4px);z-index:35}',
      '.owner-burger{display:none;width:40px;height:40px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#FAFAFA;font-size:20px;cursor:pointer}',
      '.owner-bottom-nav{display:none;position:fixed;left:0;right:0;bottom:0;padding:8px 10px calc(env(safe-area-inset-bottom,0px) + 10px);background:rgba(10,10,13,0.94);backdrop-filter:blur(20px);border-top:1px solid rgba(255,255,255,0.08);z-index:45}',
      '.owner-bottom-wrap{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
      '.owner-bottom-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px 6px;border-radius:14px;color:rgba(250,250,250,0.45);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em}',
      '.owner-bottom-item strong{font-size:18px;line-height:1}',
      '.owner-bottom-item.active{background:rgba(245,158,11,0.08);color:#FCD38D}',
      '@media (max-width:768px){',
      '  .owner-burger{display:grid;place-items:center}',
      '  .owner-overlay.show{display:block}',
      '  .sidebar{transform:translateX(-100%);transition:transform 0.22s ease}',
      '  .sidebar.open{transform:translateX(0)}',
      '  .main{margin-left:0!important}',
      '  .owner-bottom-nav{display:block}',
      '  .content{padding-bottom:90px!important}',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // ─── Upgrade Modal ─────────────────────────────────────────────────────
  function injectUpgradeModal() {
    if (document.getElementById('tt-upgrade-modal')) return;
    var overlay = document.createElement('div');
    overlay.id = 'tt-upgrade-modal';
    overlay.className = 'tt-upg-overlay';
    overlay.innerHTML =
      '<div class="tt-upg-card" role="dialog" aria-modal="true" aria-labelledby="tt-upg-title">' +
        '<div class="tt-upg-icon">🔒</div>' +
        '<h3 id="tt-upg-title">Upgrade to unlock <span id="tt-upg-feature">this feature</span></h3>' +
        '<p>You\'re on the <strong id="tt-upg-plan">Starter</strong> plan. Upgrade your license to unlock <strong id="tt-upg-feature2">this feature</strong> and more.</p>' +
        '<div class="tt-upg-actions">' +
          '<a class="tt-upg-btn primary" id="tt-upg-pro" href="#" target="_blank" rel="noopener">' +
            '<span>Upgrade to Pro</span><span class="price">$82 once</span>' +
          '</a>' +
          '<a class="tt-upg-btn" id="tt-upg-ent" href="#" target="_blank" rel="noopener">' +
            '<span>Upgrade to Enterprise</span><span class="price">$190 once</span>' +
          '</a>' +
        '</div>' +
        '<button type="button" class="tt-upg-close" id="tt-upg-close">Maybe later</button>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeUpgradeModal();
    });
    document.getElementById('tt-upg-close').addEventListener('click', closeUpgradeModal);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeUpgradeModal();
    });
  }

  function openUpgradeModal(slug, label) {
    var overlay = document.getElementById('tt-upgrade-modal');
    if (!overlay) return;
    var needed = planNeededFor(slug);
    var featureName = label || slug || 'this feature';

    document.getElementById('tt-upg-feature').textContent = featureName;
    document.getElementById('tt-upg-feature2').textContent = featureName;
    document.getElementById('tt-upg-plan').textContent = licenseState.planLabel || 'Starter';

    var pro = document.getElementById('tt-upg-pro');
    var ent = document.getElementById('tt-upg-ent');
    pro.href = licenseState.upgradeUrls.pro || '#';
    ent.href = licenseState.upgradeUrls.enterprise || '#';

    // Hide Pro button if Pro can't unlock this feature (i.e. enterprise-only)
    if (needed === 'enterprise') {
      pro.style.display = 'none';
    } else {
      pro.style.display = 'flex';
    }

    overlay.classList.add('show');
  }

  function closeUpgradeModal() {
    var overlay = document.getElementById('tt-upgrade-modal');
    if (overlay) overlay.classList.remove('show');
  }

  // ─── Full-page lock when accessing a locked page directly ──────────────
  function showFullPageLock(slug) {
    var label = slug;
    sections.forEach(function (s) {
      s.items.forEach(function (i) {
        if (i.slug === slug) label = translate(i.key, i.fallback);
      });
    });

    var main = document.querySelector('.main') || document.body;
    var content = main.querySelector('.content');
    if (content) {
      content.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;min-height:60vh;padding:40px 20px">' +
          '<div style="text-align:center;max-width:480px">' +
            '<div style="width:88px;height:88px;border-radius:24px;background:linear-gradient(135deg,#F59E0B,#D97706);display:inline-grid;place-items:center;font-size:42px;margin-bottom:24px">🔒</div>' +
            '<h1 style="font-size:1.8rem;font-weight:800;letter-spacing:-0.03em;margin-bottom:12px">' + label + ' is locked</h1>' +
            '<p style="color:rgba(250,250,250,0.66);line-height:1.6;font-size:1rem;margin-bottom:24px">This feature is not available on your current plan. Upgrade to unlock it instantly.</p>' +
            '<button type="button" id="tt-upg-page-cta" style="padding:14px 28px;border-radius:14px;border:0;background:linear-gradient(135deg,#F59E0B,#D97706);color:#111;font-weight:800;font-size:0.95rem;cursor:pointer">View upgrade options →</button>' +
          '</div>' +
        '</div>';
      var btn = document.getElementById('tt-upg-page-cta');
      if (btn) btn.addEventListener('click', function () { openUpgradeModal(slug, label); });
    }
    // Auto-open the modal after a tick
    setTimeout(function () { openUpgradeModal(slug, label); }, 350);
  }

  // ─── Fetch plan, then render sidebar ───────────────────────────────────
  function fetchLicenseStatus() {
    var key = null;
    try { key = localStorage.getItem('tta_owner_key'); } catch (e) {}
    if (!key) return Promise.resolve(null);

    return fetch('/api/license/status', { headers: { 'x-owner-key': key } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function applyLicenseStatus(data) {
    if (!data || !data.success) {
      // Fallback: assume starter so we still gate visually (fail closed for safety)
      licenseState.plan = 'starter';
      licenseState.planLabel = 'Starter';
      licenseState.pages = {
        dashboard: true, guests: true, messages: true, settings: true,
        analytics: false, floorplan: false, menu: false, waitlist: false,
        'ai-waiter': false, campaigns: false
      };
      licenseState.loaded = true;
      return;
    }
    licenseState.plan = data.plan || 'starter';
    licenseState.planLabel = data.plan_label || 'Starter';
    licenseState.pages = data.pages || null;
    licenseState.upgradeUrls = data.upgrade_urls || licenseState.upgradeUrls;
    licenseState.loaded = true;
  }

  // ─── Inject theme toggle button into topbar (if not already present) ──
  function injectThemeToggle() {
    if (document.getElementById('tt-theme-toggle')) return;
    var topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) return;
    var btn = document.createElement('button');
    btn.id = 'tt-theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle theme');
    btn.style.cssText =
      'width:38px;height:38px;border-radius:10px;' +
      'border:1px solid rgba(255,255,255,0.12);' +
      'background:rgba(255,255,255,0.04);' +
      'color:var(--text,#FAFAFA);cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      'transition:0.2s ease;margin-left:6px;flex-shrink:0;padding:0';
    topbarRight.appendChild(btn);
  }

  // ─── Mobile shell (unchanged) ──────────────────────────────────────────
  function setupMobileShell() {
    var topbarLeft = document.querySelector('.topbar-left');
    var burger = document.createElement('button');
    burger.type = 'button';
    burger.className = 'owner-burger';
    burger.setAttribute('aria-label', 'Open menu');
    burger.textContent = '☰';

    if (topbarLeft) topbarLeft.prepend(burger);

    var overlay = document.createElement('div');
    overlay.className = 'owner-overlay';
    document.body.appendChild(overlay);

    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
      burger.textContent = '☰';
    }
    function openSidebar() {
      sidebar.classList.add('open');
      overlay.classList.add('show');
      burger.textContent = '✕';
    }
    burger.addEventListener('click', function () {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
    overlay.addEventListener('click', closeSidebar);

    sidebar.addEventListener('click', function (event) {
      if (window.innerWidth <= 768 && event.target.closest('.nav-item:not(.locked)')) closeSidebar();
    });

    var tabs = [
      { href: '/dashboard', icon: '🏠', key: 'bottom_nav.home', fallback: 'Home', active: location.pathname === '/dashboard' && location.hash !== '#reservations' },
      { href: '/dashboard#reservations', icon: '📋', key: 'bottom_nav.reservations', fallback: 'Reservations', active: location.pathname === '/dashboard' && location.hash === '#reservations' },
      { href: '/messages', icon: '💬', key: 'bottom_nav.messages', fallback: 'Messages', active: location.pathname === '/messages' },
      { href: '/settings', icon: '⚙️', key: 'bottom_nav.settings', fallback: 'Settings', active: location.pathname === '/settings' }
    ];

    if (location.pathname === '/dashboard' && !location.hash) tabs[0].active = true;

    var nav = document.createElement('nav');
    nav.className = 'owner-bottom-nav';
    nav.innerHTML = '<div class="owner-bottom-wrap">' + tabs.map(function (tab) {
      return (
        '<a class="owner-bottom-item' + (tab.active ? ' active' : '') + '" href="' + tab.href + '">' +
          '<strong>' + tab.icon + '</strong>' +
          '<span data-i18n="' + tab.key + '">' + translate(tab.key, tab.fallback) + '</span>' +
        '</a>'
      );
    }).join('') + '</div>';
    document.body.appendChild(nav);

    if (typeof window.applyI18n === 'function') window.applyI18n();
  }

  // ─── Jerry floating chat button ────────────────────────────────────────
  function injectJerryChat() {
    if (document.getElementById('tt-jerry-fab')) return;

    var fab = document.createElement('button');
    fab.id = 'tt-jerry-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Ask Jerry');
    fab.innerHTML = '<span style="font-size:22px">🤖</span>';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'tt-jerry-panel';
    panel.innerHTML =
      '<div class="tt-jerry-head">' +
        '<div class="tt-jerry-avatar">🤖</div>' +
        '<div class="tt-jerry-info">' +
          '<div class="tt-jerry-name">Jerry</div>' +
          '<div class="tt-jerry-status"><span class="tt-jerry-dot"></span>Your AI Assistant</div>' +
        '</div>' +
        '<button class="tt-jerry-close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="tt-jerry-body" id="tt-jerry-body">' +
        '<div class="tt-jerry-msg bot">Hi! I\'m Jerry — your AI assistant. Ask me anything about your restaurant: today\'s reservations, top customers, revenue, trends.</div>' +
      '</div>' +
      '<form class="tt-jerry-input" id="tt-jerry-form">' +
        '<input type="text" id="tt-jerry-q" placeholder="Ask Jerry…" autocomplete="off" />' +
        '<button type="submit" aria-label="Send">→</button>' +
      '</form>';
    document.body.appendChild(panel);

    function openPanel() {
      panel.classList.add('show');
      fab.classList.add('open');
      setTimeout(function () {
        var q = document.getElementById('tt-jerry-q');
        if (q) q.focus();
      }, 200);
    }
    function closePanel() {
      panel.classList.remove('show');
      fab.classList.remove('open');
    }
    fab.addEventListener('click', function () {
      if (panel.classList.contains('show')) closePanel(); else openPanel();
    });
    panel.querySelector('.tt-jerry-close').addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('show')) closePanel();
    });

    var form = document.getElementById('tt-jerry-form');
    var body = document.getElementById('tt-jerry-body');
    var input = document.getElementById('tt-jerry-q');
    var sending = false;

    function addMsg(role, text) {
      var msg = document.createElement('div');
      msg.className = 'tt-jerry-msg ' + role;
      msg.textContent = text;
      body.appendChild(msg);
      body.scrollTop = body.scrollHeight;
      return msg;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      var q = input.value.trim();
      if (!q) return;
      sending = true;
      addMsg('user', q);
      input.value = '';
      var thinking = addMsg('bot typing', 'Thinking…');

      var key = null;
      try { key = localStorage.getItem('tta_owner_key'); } catch (_) {}

      fetch('/owner/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-key': key || '' },
        body: JSON.stringify({ question: q })
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (data) {
          thinking.remove();
          if (data && data.success && data.reply) addMsg('bot', data.reply);
          else addMsg('bot', 'Sorry, I could not answer right now. Please try again.');
        })
        .catch(function () {
          thinking.remove();
          addMsg('bot', 'Connection error. Check your internet.');
        })
        .finally(function () { sending = false; });
    });
  }

  // ─── Live clock in topbar ──────────────────────────────────────────────
  function injectLiveClock() {
    var topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight || document.getElementById('tt-live-clock')) return;
    var clock = document.createElement('div');
    clock.id = 'tt-live-clock';
    clock.setAttribute('aria-label', 'Current time');
    topbarRight.insertBefore(clock, topbarRight.firstChild);
    function tick() {
      try {
        var now = new Date();
        var t = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Tirane',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).format(now);
        var d = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Tirane',
          weekday: 'short', day: '2-digit', month: 'short'
        }).format(now);
        clock.innerHTML =
          '<span class="tt-clock-time">' + t + '</span>' +
          '<span class="tt-clock-date">' + d + '</span>';
      } catch (_) {}
    }
    tick();
    setInterval(tick, 30000);
  }

  // ─── Extra styles for Jerry + clock (dark; light handled in owner-light.css) ─
  function injectExtraStyles() {
    if (document.getElementById('owner-shell-extra')) return;
    var s = document.createElement('style');
    s.id = 'owner-shell-extra';
    s.textContent = [
      '#tt-live-clock{display:flex;flex-direction:column;align-items:flex-end;gap:2px;padding:6px 12px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-family:var(--mono,"JetBrains Mono",monospace);line-height:1}',
      '#tt-live-clock .tt-clock-time{font-size:13px;font-weight:700;color:#FAFAFA;letter-spacing:0.02em}',
      '#tt-live-clock .tt-clock-date{font-size:9px;color:rgba(250,250,250,0.5);text-transform:uppercase;letter-spacing:0.08em}',
      '[data-theme="light"] #tt-live-clock{background:rgba(0,0,0,0.03)!important;border-color:rgba(0,0,0,0.08)!important}',
      '[data-theme="light"] #tt-live-clock .tt-clock-time{color:#1a1612!important}',
      '[data-theme="light"] #tt-live-clock .tt-clock-date{color:rgba(26,22,18,0.5)!important}',
      // Jerry FAB
      '#tt-jerry-fab{position:fixed;bottom:22px;right:22px;width:58px;height:58px;border-radius:50%;border:0;background:linear-gradient(135deg,#F59E0B,#D97706);color:#111;cursor:pointer;box-shadow:0 18px 44px rgba(245,158,11,0.32),0 0 0 4px rgba(245,158,11,0.12);display:flex;align-items:center;justify-content:center;z-index:60;transition:all 0.25s cubic-bezier(0.34,1.56,0.64,1);animation:ttJerryFloat 3.5s ease-in-out infinite}',
      '#tt-jerry-fab:hover{transform:translateY(-3px) scale(1.05);box-shadow:0 22px 60px rgba(245,158,11,0.45),0 0 0 6px rgba(245,158,11,0.16)}',
      '#tt-jerry-fab.open{background:linear-gradient(135deg,#1a1612,#0a0a0c);color:#FAFAFA;box-shadow:0 18px 44px rgba(0,0,0,0.4)}',
      '@keyframes ttJerryFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
      // Jerry panel
      '#tt-jerry-panel{position:fixed;bottom:94px;right:22px;width:380px;max-width:calc(100vw - 44px);height:540px;max-height:calc(100vh - 140px);background:#0A0A0C;border:1px solid rgba(255,255,255,0.08);border-radius:22px;overflow:hidden;display:none;flex-direction:column;box-shadow:0 32px 80px rgba(0,0,0,0.6);z-index:59;font-family:var(--font,"Plus Jakarta Sans",sans-serif)}',
      '#tt-jerry-panel.show{display:flex;animation:ttJerrySlideUp 0.28s cubic-bezier(0.34,1.56,0.64,1)}',
      '@keyframes ttJerrySlideUp{from{opacity:0;transform:translateY(14px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '.tt-jerry-head{display:flex;align-items:center;gap:12px;padding:16px 18px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06)}',
      '.tt-jerry-avatar{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#F59E0B,#D97706);display:grid;place-items:center;font-size:18px;flex-shrink:0}',
      '.tt-jerry-info{flex:1;min-width:0}',
      '.tt-jerry-name{font-size:14px;font-weight:800;color:#FAFAFA;letter-spacing:-0.01em}',
      '.tt-jerry-status{display:flex;align-items:center;gap:5px;font-size:11px;color:#10B981;margin-top:2px}',
      '.tt-jerry-dot{width:5px;height:5px;border-radius:50%;background:#10B981;animation:ttJerryPulse 2s infinite}',
      '@keyframes ttJerryPulse{0%,100%{opacity:1}50%{opacity:0.35}}',
      '.tt-jerry-close{background:none;border:0;color:rgba(250,250,250,0.42);cursor:pointer;font-size:18px;padding:6px;border-radius:8px;transition:0.2s}',
      '.tt-jerry-close:hover{color:#FAFAFA;background:rgba(255,255,255,0.06)}',
      '.tt-jerry-body{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:10px}',
      '.tt-jerry-body::-webkit-scrollbar{width:4px}',
      '.tt-jerry-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:2px}',
      '.tt-jerry-msg{max-width:86%;padding:11px 15px;border-radius:14px;font-size:13px;line-height:1.55;word-wrap:break-word;animation:ttJerryFadeIn 0.25s ease;white-space:pre-wrap}',
      '@keyframes ttJerryFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
      '.tt-jerry-msg.bot{background:rgba(255,255,255,0.05);color:#FAFAFA;border:1px solid rgba(255,255,255,0.06);align-self:flex-start;border-bottom-left-radius:4px}',
      '.tt-jerry-msg.user{background:linear-gradient(135deg,#F59E0B,#D97706);color:#111;align-self:flex-end;border-bottom-right-radius:4px;font-weight:600}',
      '.tt-jerry-msg.typing{color:rgba(250,250,250,0.5);font-style:italic}',
      '.tt-jerry-input{display:flex;gap:8px;padding:14px;border-top:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)}',
      '#tt-jerry-q{flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:11px 14px;color:#FAFAFA;font:500 13px var(--font,"Plus Jakarta Sans",sans-serif);outline:none;transition:border-color 0.2s}',
      '#tt-jerry-q:focus{border-color:rgba(245,158,11,0.4)}',
      '#tt-jerry-q::placeholder{color:rgba(250,250,250,0.42)}',
      '.tt-jerry-input button[type=submit]{width:42px;height:42px;border-radius:12px;border:0;background:linear-gradient(135deg,#F59E0B,#D97706);color:#111;cursor:pointer;font-size:18px;font-weight:800;flex-shrink:0;transition:0.2s}',
      '.tt-jerry-input button[type=submit]:hover{transform:scale(1.05)}',
      // Light mode
      '[data-theme="light"] #tt-jerry-panel{background:#FFFFFF!important;border-color:rgba(0,0,0,0.08)!important;box-shadow:0 32px 80px rgba(0,0,0,0.18)!important}',
      '[data-theme="light"] .tt-jerry-head{background:rgba(0,0,0,0.025)!important;border-bottom-color:rgba(0,0,0,0.06)!important}',
      '[data-theme="light"] .tt-jerry-name{color:#1a1612!important}',
      '[data-theme="light"] .tt-jerry-close{color:rgba(26,22,18,0.42)!important}',
      '[data-theme="light"] .tt-jerry-close:hover{background:rgba(0,0,0,0.05)!important;color:#1a1612!important}',
      '[data-theme="light"] .tt-jerry-msg.bot{background:rgba(0,0,0,0.04)!important;color:#1a1612!important;border-color:rgba(0,0,0,0.06)!important}',
      '[data-theme="light"] .tt-jerry-input{background:rgba(0,0,0,0.02)!important;border-top-color:rgba(0,0,0,0.06)!important}',
      '[data-theme="light"] #tt-jerry-q{background:rgba(0,0,0,0.03)!important;border-color:rgba(0,0,0,0.1)!important;color:#1a1612!important}',
      '[data-theme="light"] #tt-jerry-q::placeholder{color:rgba(26,22,18,0.42)!important}',
      '@media(max-width:560px){#tt-jerry-panel{width:calc(100vw - 24px);right:12px;bottom:86px;height:calc(100vh - 160px)}#tt-jerry-fab{bottom:86px;right:14px;width:54px;height:54px}}',
      // Hide Jerry FAB when mobile bottom nav is visible and overlaps
      '@media(max-width:768px){#tt-jerry-fab{bottom:90px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ─── Boot ──────────────────────────────────────────────────────────────
  ensureStyles();
  injectExtraStyles();
  injectUpgradeModal();
  injectThemeToggle();
  injectLiveClock();
  injectJerryChat();
  setupMobileShell();
  // Initial render with no gating (in case license fetch fails / slow)
  renderSidebar();

  // ?plan=starter|pro|enterprise query param override for testing
  function getPlanOverride() {
    try {
      var params = new URLSearchParams(location.search);
      var p = params.get('plan');
      if (p && ['starter', 'pro', 'enterprise'].indexOf(p) !== -1) return p;
    } catch (e) {}
    return null;
  }

  function buildFakeLicenseData(plan) {
    var starter  = ['dashboard', 'guests', 'messages', 'settings'];
    var pro      = ['dashboard', 'analytics', 'guests', 'messages', 'floorplan', 'menu', 'waitlist', 'settings'];
    var enterprise = ['dashboard', 'analytics', 'guests', 'messages', 'floorplan', 'menu', 'waitlist', 'ai-waiter', 'campaigns', 'settings'];
    var enabled = plan === 'enterprise' ? enterprise : plan === 'pro' ? pro : starter;
    var allPages = ['dashboard','analytics','guests','messages','floorplan','menu','waitlist','ai-waiter','campaigns','settings'];
    var pages = {};
    allPages.forEach(function (p) { pages[p] = enabled.indexOf(p) !== -1; });
    var label = plan === 'enterprise' ? 'Enterprise' : plan === 'pro' ? 'Pro' : 'Starter';
    return { success: true, plan: plan, plan_label: label, pages: pages, upgrade_urls: { pro: '#', enterprise: '#' } };
  }

  var planOverride = getPlanOverride();
  if (planOverride) {
    applyLicenseStatus(buildFakeLicenseData(planOverride));
    renderSidebar();
    var currentSlug = ownerPages[location.pathname];
    if (currentSlug && isPageLocked(currentSlug)) {
      showFullPageLock(currentSlug);
    }
  } else {
    fetchLicenseStatus().then(function (data) {
      applyLicenseStatus(data);
      renderSidebar();

      // If current page is locked, show full-page lock
      var currentSlug = ownerPages[location.pathname];
      if (currentSlug && isPageLocked(currentSlug)) {
        showFullPageLock(currentSlug);
      }
    });
  }
})();
