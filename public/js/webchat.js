/**
 * Te Ta AI — Web Chat Widget
 * Embed on any restaurant website:
 *   <script src="https://your-domain/js/webchat.js" data-restaurant="RESTAURANT_ID"></script>
 *
 * Creates a floating chat bubble (bottom-right) that opens a chat interface.
 * Same AI brain as WhatsApp/Instagram — just a different channel.
 */
(function() {
  'use strict';

  // Find the script tag to read data attributes
  var scripts = document.getElementsByTagName('script');
  var currentScript = scripts[scripts.length - 1];
  var restaurantId = currentScript.getAttribute('data-restaurant');
  var baseUrl = currentScript.src.replace('/js/webchat.js', '');

  if (!restaurantId) {
    console.error('[TeTa WebChat] Missing data-restaurant attribute');
    return;
  }

  // Generate or retrieve session ID
  var SESSION_KEY = 'tta_webchat_' + restaurantId;
  var sessionId = null;
  try {
    sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = 'wc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch(e) {
    sessionId = 'wc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  var isOpen = false;
  var messages = [];
  var container, bubble, panel, msgContainer, input;

  function createStyles() {
    var style = document.createElement('style');
    style.textContent = [
      '#tta-wc-container { position:fixed; bottom:20px; right:20px; z-index:99999; font-family:"Plus Jakarta Sans",system-ui,sans-serif; font-size:14px; }',
      '#tta-wc-bubble { width:56px; height:56px; border-radius:16px; background:linear-gradient(135deg,#D97706,#F59E0B); color:#000; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 20px rgba(245,158,11,0.3); transition:all 0.3s cubic-bezier(0.34,1.56,0.64,1); }',
      '#tta-wc-bubble:hover { transform:scale(1.1); box-shadow:0 6px 30px rgba(245,158,11,0.4); }',
      '#tta-wc-bubble svg { width:24px; height:24px; }',
      '#tta-wc-panel { display:none; width:360px; height:520px; background:#09090B; border:1px solid rgba(255,255,255,0.06); border-radius:16px; overflow:hidden; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.5); position:absolute; bottom:68px; right:0; }',
      '#tta-wc-panel.open { display:flex; animation:ttaSlideUp 0.3s cubic-bezier(0.34,1.56,0.64,1); }',
      '@keyframes ttaSlideUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }',
      '#tta-wc-header { padding:16px; background:rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; gap:10px; flex-shrink:0; }',
      '#tta-wc-header .logo { width:32px; height:32px; border-radius:8px; background:linear-gradient(135deg,#D97706,#F59E0B); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:10px; color:#000; }',
      '#tta-wc-header .info { flex:1; }',
      '#tta-wc-header .name { font-weight:700; color:#FAFAFA; font-size:14px; }',
      '#tta-wc-header .status { font-size:11px; color:#10B981; display:flex; align-items:center; gap:4px; }',
      '#tta-wc-header .status-dot { width:5px; height:5px; border-radius:50%; background:#10B981; animation:ttaPulse 2s infinite; }',
      '@keyframes ttaPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }',
      '#tta-wc-header .close { background:none; border:none; color:#71717A; cursor:pointer; padding:4px; border-radius:6px; transition:color 0.2s; }',
      '#tta-wc-header .close:hover { color:#FAFAFA; }',
      '#tta-wc-messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }',
      '#tta-wc-messages::-webkit-scrollbar { width:4px; }',
      '#tta-wc-messages::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }',
      '.tta-msg { max-width:85%; padding:10px 14px; border-radius:12px; font-size:13px; line-height:1.5; word-wrap:break-word; animation:ttaFadeIn 0.3s ease; }',
      '@keyframes ttaFadeIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }',
      '.tta-msg.bot { background:rgba(255,255,255,0.05); color:#FAFAFA; border:1px solid rgba(255,255,255,0.06); align-self:flex-start; border-bottom-left-radius:4px; }',
      '.tta-msg.user { background:linear-gradient(135deg,#D97706,#F59E0B); color:#000; align-self:flex-end; border-bottom-right-radius:4px; }',
      '.tta-msg.typing { color:#71717A; font-style:italic; }',
      '#tta-wc-input-wrap { padding:12px; border-top:1px solid rgba(255,255,255,0.06); display:flex; gap:8px; background:rgba(255,255,255,0.02); flex-shrink:0; }',
      '#tta-wc-input { flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:10px 14px; color:#FAFAFA; font-family:inherit; font-size:13px; outline:none; transition:border-color 0.2s; }',
      '#tta-wc-input:focus { border-color:rgba(245,158,11,0.4); }',
      '#tta-wc-input::placeholder { color:#71717A; }',
      '#tta-wc-send { width:38px; height:38px; border-radius:10px; background:linear-gradient(135deg,#D97706,#F59E0B); color:#000; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity 0.2s; flex-shrink:0; }',
      '#tta-wc-send:disabled { opacity:0.3; cursor:not-allowed; }',
      '#tta-wc-send svg { width:16px; height:16px; }',
      '@media (max-width:400px) { #tta-wc-panel { width:calc(100vw - 24px); right:-8px; height:70vh; } }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function createWidget() {
    container = document.createElement('div');
    container.id = 'tta-wc-container';

    // Chat bubble
    bubble = document.createElement('button');
    bubble.id = 'tta-wc-bubble';
    bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    bubble.onclick = togglePanel;

    // Chat panel
    panel = document.createElement('div');
    panel.id = 'tta-wc-panel';
    panel.innerHTML =
      '<div id="tta-wc-header">' +
        '<div class="logo">TT</div>' +
        '<div class="info">' +
          '<div class="name">Te Ta AI</div>' +
          '<div class="status"><span class="status-dot"></span>Online</div>' +
        '</div>' +
        '<button class="close" onclick="document.getElementById(\'tta-wc-bubble\').click()">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div id="tta-wc-messages"></div>' +
      '<div id="tta-wc-input-wrap">' +
        '<input type="text" id="tta-wc-input" placeholder="Type a message..." />' +
        '<button id="tta-wc-send" disabled>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button>' +
      '</div>';

    container.appendChild(panel);
    container.appendChild(bubble);
    document.body.appendChild(container);

    msgContainer = document.getElementById('tta-wc-messages');
    input = document.getElementById('tta-wc-input');
    var sendBtn = document.getElementById('tta-wc-send');

    input.addEventListener('input', function() {
      sendBtn.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && input.value.trim()) sendMessage();
    });
    sendBtn.addEventListener('click', sendMessage);

    // Welcome message
    addMessage('bot', 'Welcome! How can I help you today? I can take reservations, tell you about the menu, or help with any other question.');
  }

  function togglePanel() {
    isOpen = !isOpen;
    if (isOpen) {
      panel.classList.add('open');
      bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      setTimeout(function() { input.focus(); }, 100);
    } else {
      panel.classList.remove('open');
      bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    }
  }

  function addMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'tta-msg ' + role;
    div.textContent = text;
    msgContainer.appendChild(div);
    msgContainer.scrollTop = msgContainer.scrollHeight;
    messages.push({ role: role, text: text });
    return div;
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;

    addMessage('user', text);
    input.value = '';
    document.getElementById('tta-wc-send').disabled = true;

    // Show typing indicator
    var typing = addMessage('bot', 'Thinking...');
    typing.classList.add('typing');

    fetch(baseUrl + '/webhook/webchat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: parseInt(restaurantId),
        session_id: sessionId,
        text: text,
        name: 'Web Visitor'
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      typing.remove();
      if (data.reply) {
        addMessage('bot', data.reply);
      } else {
        addMessage('bot', 'Sorry, I could not respond. Please try again.');
      }
    })
    .catch(function() {
      typing.remove();
      addMessage('bot', 'Connection error. Check your internet and try again.');
    });
  }

  // Initialize
  createStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }
})();
