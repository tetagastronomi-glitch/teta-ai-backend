/**
 * hd-ux.js — Dashboard UX excellence layer
 *
 * Adds to every dashboard page:
 *   - Keyboard shortcuts (D/R/G/A/S/J/N/? /Esc)
 *   - Animated stat counters (.stat-value[data-count])
 *   - Notification bell with unread badge (polls /api/notifications/unread)
 *   - Reservation detail side panel (opened via row click or ?res=ID)
 *   - Subtle fade-in on page load
 *
 * Dependencies: hd.css (tokens), optional jQuery-free.
 * Load via <script defer src="/hd-ux.js"></script>
 */

(function () {
  'use strict';

  // ─── Keyboard shortcuts ──────────────────────────────────────────────
  const SHORTCUTS = {
    'd': '/dashboard.html',
    'r': '/dashboard.html#reservations',
    'g': '/guests.html',
    'a': '/analytics.html',
    's': '/settings.html',
    'm': '/messages.html',
    'n': null,   // toggle notifications bell
    'j': null,   // toggle Jerry panel
    '?': null,   // show help overlay
  };

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
      // Close any open panels
      document.querySelectorAll('.hd-jerry-panel.open, .hd-detail-panel.open, .hd-notif-panel.open')
        .forEach(el => el.classList.remove('open'));
      return;
    }

    const k = e.key.toLowerCase();
    if (!(k in SHORTCUTS)) return;

    const route = SHORTCUTS[k];
    if (route) {
      e.preventDefault();
      window.location.href = route;
      return;
    }

    if (k === 'j') {
      e.preventDefault();
      document.querySelector('.hd-jerry-panel')?.classList.toggle('open');
    } else if (k === 'n') {
      e.preventDefault();
      document.querySelector('.hd-notif-panel')?.classList.toggle('open');
    } else if (k === '?') {
      e.preventDefault();
      showShortcutHelp();
    }
  });

  function showShortcutHelp() {
    let el = document.getElementById('hd-shortcut-help');
    if (el) { el.remove(); return; }
    el = document.createElement('div');
    el.id = 'hd-shortcut-help';
    el.style.cssText = `
      position:fixed;inset:0;background:rgba(26,23,20,0.5);
      display:flex;align-items:center;justify-content:center;z-index:1000;
      animation:hdFadeIn .2s ease both;
    `;
    el.innerHTML = `
      <div style="background:var(--surface);border-radius:var(--radius-lg);padding:var(--sp-5);
                  box-shadow:var(--shadow-xl);max-width:420px;border:1px solid var(--line);">
        <h3 style="margin-bottom:var(--sp-3)">⌨️ Keyboard shortcuts</h3>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-4);font-size:var(--fs-sm)">
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">D</kbd><span>Dashboard</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">R</kbd><span>Reservations</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">G</kbd><span>Guests</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">A</kbd><span>Analytics</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">M</kbd><span>Messages</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">S</kbd><span>Settings</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">J</kbd><span>Toggle Jerry chat</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">N</kbd><span>Toggle notifications</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">?</kbd><span>This help</span>
          <kbd style="font-family:monospace;background:var(--surface-sunk);padding:2px 8px;border-radius:4px">Esc</kbd><span>Close panels</span>
        </div>
        <p style="margin-top:var(--sp-3);font-size:var(--fs-xs);color:var(--ink-mute)">Press ? again to close.</p>
      </div>
    `;
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
    document.body.appendChild(el);
  }

  // ─── Animated stat counters ──────────────────────────────────────────
  function animateCounter(el, target, duration = 900) {
    const start = performance.now();
    const from = 0;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (target - from) * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = Number(target).toLocaleString();
    }
    requestAnimationFrame(tick);
  }

  function hookCounters() {
    document.querySelectorAll('.stat-value[data-count]').forEach(el => {
      const target = Number(el.getAttribute('data-count')) || 0;
      animateCounter(el, target);
    });
  }

  // ─── Notification bell ───────────────────────────────────────────────
  function setupNotificationBell() {
    const bell = document.querySelector('.hd-bell');
    if (!bell) return;

    async function poll() {
      try {
        const ownerKey = localStorage.getItem('tta_owner_key') || '';
        if (!ownerKey) return;
        const r = await fetch('/api/notifications/unread', {
          headers: { 'x-owner-key': ownerKey },
        });
        if (!r.ok) return;
        const j = await r.json();
        const count = Number(j.count) || 0;
        let dot = bell.querySelector('.badge-dot');
        if (count > 0) {
          if (!dot) {
            dot = document.createElement('span');
            dot.className = 'badge-dot';
            bell.appendChild(dot);
          }
          dot.textContent = count > 9 ? '9+' : String(count);
        } else if (dot) {
          dot.remove();
        }
      } catch (_) { /* silent */ }
    }

    poll();
    setInterval(poll, 30000);
  }

  // ─── Reservation detail side panel ───────────────────────────────────
  function setupDetailPanel() {
    let panel = document.querySelector('.hd-detail-panel');
    if (!panel) {
      panel = document.createElement('aside');
      panel.className = 'hd-detail-panel';
      panel.style.cssText = `
        position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);
        background:var(--surface);border-left:1px solid var(--line);
        box-shadow:var(--shadow-xl);padding:var(--sp-5);z-index:95;
        overflow-y:auto;transform:translateX(110%);
        transition:transform var(--t-slow) var(--ease-out);
      `;
      document.body.appendChild(panel);
      const style = document.createElement('style');
      style.textContent = '.hd-detail-panel.open{transform:translateX(0)!important}';
      document.head.appendChild(style);
    }

    document.addEventListener('click', (e) => {
      const row = e.target.closest('[data-reservation-id]');
      if (!row) return;
      const id = row.getAttribute('data-reservation-id');
      openDetail(panel, id);
    });

    // Deep link support: ?res=123
    const urlRes = new URLSearchParams(window.location.search).get('res');
    if (urlRes) openDetail(panel, urlRes);
  }

  async function openDetail(panel, id) {
    panel.classList.add('open');
    panel.innerHTML = `
      <button onclick="this.closest('.hd-detail-panel').classList.remove('open')"
              style="position:absolute;top:var(--sp-3);right:var(--sp-3);
                     background:transparent;border:none;font-size:24px;cursor:pointer;
                     color:var(--ink-soft)">×</button>
      <div class="hd-skeleton" style="height:32px;width:60%;margin-bottom:var(--sp-3)"></div>
      <div class="hd-skeleton" style="height:14px;width:100%;margin-bottom:var(--sp-2)"></div>
      <div class="hd-skeleton" style="height:14px;width:90%;margin-bottom:var(--sp-2)"></div>
      <div class="hd-skeleton" style="height:14px;width:75%"></div>
    `;
    try {
      const ownerKey = localStorage.getItem('tta_owner_key') || '';
      const r = await fetch(`/owner/reservations/${id}`, {
        headers: { 'x-owner-key': ownerKey },
      });
      if (!r.ok) throw new Error('Could not load reservation');
      const res = await r.json();
      const data = res.data || res;
      panel.innerHTML = `
        <button onclick="this.closest('.hd-detail-panel').classList.remove('open')"
                style="position:absolute;top:var(--sp-3);right:var(--sp-3);
                       background:transparent;border:none;font-size:24px;cursor:pointer;
                       color:var(--ink-soft)">×</button>
        <h2 style="margin-bottom:var(--sp-1)">${escapeHtml(data.name || 'Reservation')}</h2>
        <p class="hd-mute" style="margin-bottom:var(--sp-4)">#${id}</p>
        <div class="hd-col">
          <div class="hd-row"><strong style="min-width:90px">Date</strong><span>${escapeHtml(data.date || '—')}</span></div>
          <div class="hd-row"><strong style="min-width:90px">Time</strong><span>${escapeHtml(data.time || '—')}</span></div>
          <div class="hd-row"><strong style="min-width:90px">People</strong><span>${escapeHtml(String(data.people ?? '—'))}</span></div>
          <div class="hd-row"><strong style="min-width:90px">Phone</strong><span class="hd-mono">${escapeHtml(data.phone || '—')}</span></div>
          <div class="hd-row"><strong style="min-width:90px">Status</strong><span class="badge ${badgeClass(data.status)}">${escapeHtml(data.status || 'pending')}</span></div>
          ${data.notes ? `<div style="margin-top:var(--sp-3)"><strong>Notes</strong><p style="color:var(--ink-soft);margin-top:var(--sp-1)">${escapeHtml(data.notes)}</p></div>` : ''}
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `
        <button onclick="this.closest('.hd-detail-panel').classList.remove('open')"
                style="position:absolute;top:var(--sp-3);right:var(--sp-3);
                       background:transparent;border:none;font-size:24px;cursor:pointer;
                       color:var(--ink-soft)">×</button>
        <div class="hd-empty">
          <div class="emoji">⚠️</div>
          <h3>Could not load reservation</h3>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  function badgeClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'confirmed' || s === 'completed') return 'ok';
    if (s === 'cancelled' || s === 'declined') return 'err';
    if (s === 'pending') return 'warn';
    return 'info';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Boot ─────────────────────────────────────────────────────────────
  function boot() {
    document.body.classList.add('hd-fade-in');
    hookCounters();
    setupNotificationBell();
    setupDetailPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
