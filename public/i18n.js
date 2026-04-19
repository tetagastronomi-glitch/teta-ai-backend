/**
 * Te Ta AI — i18n loader
 * Usage:
 *   <script src="/i18n.js"></script>
 *   <span data-i18n="nav.reservations">Rezervimet</span>
 *   <button data-i18n="actions.confirm">Konfirmo</button>
 *   <input data-i18n-placeholder="dashboard.support_placeholder">
 *
 * In JS: t('status.confirmed')  →  "Confirmed" (or locale equivalent)
 */

(function() {
  let _locale = {};
  let _lang = 'en'; // fallback

  /**
   * Load locale from /locales/{lang}.json
   * Falls back to Albanian if not found.
   */
  async function loadLocale(lang, options) {
    const persist = !options || options.persist !== false;
    try {
      const r = await fetch('/locales/' + lang + '.json');
      if (!r.ok) throw new Error('not found');
      _locale = await r.json();
      _lang = lang;
      if (persist) localStorage.setItem('tta_lang', lang);
      // RTL support
      if (_locale.dir === 'rtl') {
        document.documentElement.setAttribute('dir', 'rtl');
        document.documentElement.setAttribute('lang', lang);
      } else {
        document.documentElement.setAttribute('dir', 'ltr');
        document.documentElement.setAttribute('lang', lang);
      }
      applyTranslations();
      document.dispatchEvent(new CustomEvent('i18n:ready', { detail: { lang } }));
    } catch (_) {
      if (lang !== 'en') await loadLocale('en', options);
    }
  }

  /**
   * Translate a dot-notation key, e.g. t('status.confirmed')
   */
  window.t = function(key, fallback) {
    const parts = key.split('.');
    let val = _locale;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback || key;
      val = val[p];
    }
    return (val != null && typeof val === 'string') ? val : (fallback || key);
  };

  /**
   * Apply translations to all [data-i18n] elements in the DOM.
   */
  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = window.t(key);
      if (val !== key) el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = window.t(key);
      if (val !== key) el.setAttribute('placeholder', val);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const val = window.t(key);
      if (val !== key) el.setAttribute('title', val);
    });
  }

  /**
   * Re-apply translations (call after dynamic DOM changes).
   */
  window.applyI18n = applyTranslations;

  /**
   * Get current language code.
   */
  window.getLang = function() { return _lang; };

  window.setLang = async function(lang, options) {
    const supported = ['en','sq','es','pt','tr','de','fr','ar'];
    const next = supported.includes(lang) ? lang : 'en';
    await loadLocale(next, options);
  };

  /**
   * Get the AI bot language instruction string.
   */
  window.getAiBotLangInstruction = function() {
    return window.t('ai_bot.system_language', 'Always respond in the language the customer writes in.');
  };

  /**
   * Init — reads lang from localStorage (set during Setup Wizard).
   * Falls back to browser language, then Albanian.
   */
  async function init() {
    const stored = localStorage.getItem('tta_lang');
    const pageDefault = (document.documentElement.getAttribute('lang') || 'en').split('-')[0];
    const browser = (navigator.language || 'sq').split('-')[0];
    const supported = ['en','sq','es','pt','tr','de','fr','ar'];
    const lang = supported.includes(stored) ? stored
               : supported.includes(pageDefault) ? pageDefault
               : supported.includes(browser) ? browser
               : 'en';
    await loadLocale(lang);
  }

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
