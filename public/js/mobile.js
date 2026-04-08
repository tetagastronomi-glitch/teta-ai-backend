/**
 * Te Ta AI — Mobile Navigation Controller
 * Handles hamburger toggle, sidebar overlay, and bottom nav.
 */
(function() {
  function init() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return; // Pages without sidebar (login, setup) skip

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Create hamburger button in topbar
    const topbar = document.querySelector('.topbar');
    if (topbar) {
      const hamburger = document.createElement('button');
      hamburger.className = 'hamburger';
      hamburger.setAttribute('aria-label', 'Menu');
      hamburger.innerHTML = '☰';
      const topbarLeft = topbar.querySelector('.topbar-left') || topbar;
      topbarLeft.insertBefore(hamburger, topbarLeft.firstChild);

      hamburger.addEventListener('click', function() {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('show');
        hamburger.innerHTML = sidebar.classList.contains('open') ? '✕' : '☰';
      });
    }

    // Close sidebar on overlay click
    overlay.addEventListener('click', function() {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
      const hamburger = document.querySelector('.hamburger');
      if (hamburger) hamburger.innerHTML = '☰';
    });

    // Close sidebar on nav item click (mobile)
    sidebar.querySelectorAll('.nav-item').forEach(function(item) {
      item.addEventListener('click', function() {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('open');
          overlay.classList.remove('show');
          const hamburger = document.querySelector('.hamburger');
          if (hamburger) hamburger.innerHTML = '☰';
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
