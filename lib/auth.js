const crypto = require("crypto");

function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function safeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  const ba = Buffer.from(sa);
  const bb = Buffer.from(sb);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function genApiKey() {
  return "tta_api_key_" + crypto.randomBytes(16).toString("hex");
}

function genOwnerKey() {
  return "tta_owner_key_" + crypto.randomBytes(16).toString("hex");
}

module.exports = { hashKey, safeEqual, genApiKey, genOwnerKey };
