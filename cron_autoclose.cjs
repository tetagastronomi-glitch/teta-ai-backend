// cron_autoclose.cjs
const https = require("https");
const http = require("http");

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://teta-ai-backend-production.up.railway.app";
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error("❌ ADMIN_KEY missing");
  process.exit(1);
}

function post(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;

    const opts = {
      method: "POST",
      hostname: u.hostname,
      port: u.port ? Number(u.port) : (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    };

    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.end();
  });
}

(async () => {
  try {
    const url = `${BASE_URL}/cron/auto-close`;
    console.log("CALLING:", url);

    const r = await post(url, { "x-admin-key": ADMIN_KEY });
    console.log("STATUS:", r.status);
    console.log("BODY:", r.body);

    process.exit(r.status >= 200 && r.status < 300 ? 0 : 1);
  } catch (e) {
    console.error("❌ cron failed:", e?.message || e);
    process.exit(1);
  }
})();
