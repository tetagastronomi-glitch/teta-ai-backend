(function () {
  if (window.__ttaDemoWidgetMounted) return;
  window.__ttaDemoWidgetMounted = true;

  const style = document.createElement('style');
  style.textContent = `
    #tta-demo-root{position:fixed;right:18px;bottom:18px;z-index:99999;font-family:"Plus Jakarta Sans",system-ui,sans-serif}
    #tta-demo-bubble{width:58px;height:58px;border:none;border-radius:999px;cursor:pointer;font-size:22px;background:linear-gradient(135deg,#D97706,#F59E0B);box-shadow:0 14px 35px rgba(0,0,0,.45)}
    #tta-demo-panel{display:none;position:absolute;right:0;bottom:70px;width:360px;height:520px;background:#0B0B0E;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.55)}
    #tta-demo-panel.open{display:flex;flex-direction:column}
    #tta-demo-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);color:#FAFAFA}
    #tta-demo-head button{background:transparent;color:#A1A1AA;border:none;cursor:pointer;font-size:18px}
    #tta-demo-msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
    .tta-demo-msg{max-width:82%;padding:9px 11px;border-radius:11px;font-size:13px;line-height:1.45;white-space:pre-wrap}
    .tta-demo-msg.bot{color:#FAFAFA;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);align-self:flex-start}
    .tta-demo-msg.user{color:#111;background:linear-gradient(135deg,#D97706,#F59E0B);align-self:flex-end}
    #tta-demo-form{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.08)}
    #tta-demo-input{flex:1;background:#09090B;color:#FAFAFA;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:9px 10px}
    #tta-demo-send{border:none;border-radius:10px;padding:9px 12px;cursor:pointer;font-weight:700;background:linear-gradient(135deg,#D97706,#F59E0B);color:#111}
    @media(max-width:520px){#tta-demo-root{right:10px;bottom:10px}#tta-demo-panel{position:fixed;left:10px;right:10px;bottom:76px;width:auto;height:62vh}}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'tta-demo-root';
  root.innerHTML = `
    <div id="tta-demo-panel">
      <div id="tta-demo-head"><strong>Live Demo Bot</strong><button type="button" id="tta-demo-close">x</button></div>
      <div id="tta-demo-msgs"></div>
      <form id="tta-demo-form">
        <input id="tta-demo-input" placeholder="Ask the bot..." autocomplete="off" />
        <button id="tta-demo-send" type="submit">Send</button>
      </form>
    </div>
    <button id="tta-demo-bubble" aria-label="Open demo chat">💬</button>
  `;
  document.body.appendChild(root);

  const panel = document.getElementById('tta-demo-panel');
  const bubble = document.getElementById('tta-demo-bubble');
  const closeBtn = document.getElementById('tta-demo-close');
  const form = document.getElementById('tta-demo-form');
  const input = document.getElementById('tta-demo-input');
  const msgs = document.getElementById('tta-demo-msgs');
  const history = [];

  function add(role, text) {
    const d = document.createElement('div');
    d.className = `tta-demo-msg ${role}`;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  async function send(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    add('user', clean);
    history.push({ role: 'user', content: clean });
    const typing = add('bot', 'Typing...');
    input.value = '';
    try {
      const r = await fetch('/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: clean, history: history.slice(-8) }),
      });
      const data = await r.json();
      typing.remove();
      const reply = data.reply || 'Demo is temporarily unavailable.';
      add('bot', reply);
      history.push({ role: 'assistant', content: reply });
    } catch (_e) {
      typing.remove();
      add('bot', 'Connection issue. Please try again.');
    }
  }

  bubble.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && msgs.children.length === 0) {
      add('bot', 'Try me live. Ask opening hours or request a reservation.');
    }
  });
  closeBtn.addEventListener('click', function () { panel.classList.remove('open'); });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
})();
