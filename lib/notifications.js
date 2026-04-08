async function safeFetch(url, options) {
  if (typeof fetch === "function") return fetch(url, options);
  const mod = await import("node-fetch");
  return mod.default(url, options);
}

async function sendMakeEvent(type, payload) {
  const makeWebhook = String(process.env.MAKE_ALERTS_WEBHOOK_URL || "").trim();
  const t = String(type || "").trim();
  if (!makeWebhook || !t) return { ok: false, skipped: true };

  const body = { type: t, ...(payload || {}) };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const r = await safeFetch(makeWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      console.error("⚠️ sendMakeEvent: Make non-OK", r.status, text.slice(0, 200));
      return { ok: false, status: r.status };
    }

    return { ok: true, status: r.status };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout calling Make webhook" : String(e?.message || e);
    console.error("⚠️ sendMakeEvent failed (non-blocking):", msg);
    return { ok: false, error: msg };
  }
}

function fireMakeEvent(type, payload) {
  sendMakeEvent(type, payload).catch(() => {});
}

function fireFeedbackRequest(payload) {
  fireMakeEvent("feedback_request", payload);
}

module.exports = { safeFetch, sendMakeEvent, fireMakeEvent, fireFeedbackRequest };
