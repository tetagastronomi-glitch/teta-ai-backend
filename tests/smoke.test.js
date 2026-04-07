"use strict";

/**
 * Te Ta AI Backend — Smoke Tests
 * Runner: node --test tests/smoke.test.js
 * Zero external test dependencies (node:test + node:assert built-in).
 *
 * Strategy for DB isolation:
 *   We mock require('../db') BEFORE any route/middleware that uses it.
 *   Node's module cache (require.cache) is the interception point — once
 *   we plant a fake module at the resolved path, every subsequent require
 *   for that path gets our mock automatically.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

// ─────────────────────────────────────────────────────────
// 0. ENV SETUP  (must happen before any project module loads)
// ─────────────────────────────────────────────────────────
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
process.env.API_KEY = "test-api-key-123";
process.env.ADMIN_KEY = "test-admin-key-456";
process.env.RESTAURANT_ID = "1";
process.env.NODE_ENV = "test";

// ─────────────────────────────────────────────────────────
// 1. DB MOCK  — plant fake pool before any module loads it
// ─────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");

// Resolve the exact cache key Node will use for db.js
const DB_MODULE_KEY = require.resolve(path.join(ROOT, "db.js"));

// Build a mock pool that never touches a real database
const mockPool = {
  query: async (sql, params) => {
    // Mimic queries used in auth middleware — return empty rows by default
    const s = String(sql || "").toLowerCase();

    if (s.includes("api_keys") && s.includes("key_hash")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("owner_keys") && s.includes("key_hash")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("select now()")) {
      return { rows: [{ now: new Date().toISOString() }], rowCount: 1 };
    }
    if (s.includes("current_timestamp") && s.includes("date")) {
      return { rows: [{ d: "2026-04-07" }], rowCount: 1 };
    }
    if (s.includes("current_timestamp") && s.includes("time")) {
      return { rows: [{ now_hhmi: "10:00" }], rowCount: 1 };
    }
    if (s.includes("restaurants") && s.includes("select plan")) {
      return { rows: [{ plan: "PRO", trial_ends: null, plan_expires: null }], rowCount: 1 };
    }
    // PIN login — match by pin_code
    if (s.includes("restaurants") && s.includes("pin_code")) {
      const pin = params?.[0];
      if (pin === "1234") {
        return { rows: [{ id: 1, name: "Test Restaurant" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    // Restaurant rules for getRestaurantRules
    if (s.includes("restaurants") && s.includes("max_auto_confirm_people")) {
      return {
        rows: [{
          max_auto_confirm_people: 6,
          same_day_cutoff_hhmi: "11:00",
          opening_hours_start: "11:00",
          opening_hours_end: "21:00",
          max_capacity: 50,
        }],
        rowCount: 1,
      };
    }
    // Reservation count for capacity check
    if (s.includes("reservations") && s.includes("count")) {
      return { rows: [{ cnt: 0 }], rowCount: 1 };
    }
    if (s.includes("update") || s.includes("insert")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  // Pool event surface — harmless no-ops
  on: () => {},
  end: async () => {},
};

// Also suppress the pg type parser side-effect when db.js loads
// by intercepting pg itself — but simpler: just plant the mock directly
require.cache[DB_MODULE_KEY] = {
  id: DB_MODULE_KEY,
  filename: DB_MODULE_KEY,
  loaded: true,
  exports: mockPool,
  children: [],
  paths: [],
  parent: null,
};

// ─────────────────────────────────────────────────────────
// HELPER: make a raw HTTP request against a Node server
// ─────────────────────────────────────────────────────────
function request(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: opts.path || "/",
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text: body, json });
      });
    });

    req.on("error", reject);

    if (opts.body) {
      const payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      req.write(payload);
    }
    req.end();
  });
}

// Start an Express app on a random port, run fn(server), then close
function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", async () => {
      try {
        await fn(server);
        server.close(resolve);
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────
// 2. MODULE LOADING TESTS
// ─────────────────────────────────────────────────────────
test("Module loading — config/constants", () => {
  const mod = require(path.join(ROOT, "config/constants"));
  assert.ok(mod.APP_VERSION, "APP_VERSION should be defined");
  assert.equal(typeof mod.APP_VERSION, "string");
});

test("Module loading — lib/state", () => {
  const mod = require(path.join(ROOT, "lib/state"));
  assert.ok(typeof mod === "object", "state should be an object");
  assert.ok("DB_READY" in mod, "state should have DB_READY");
});

test("Module loading — lib/auth", () => {
  const mod = require(path.join(ROOT, "lib/auth"));
  assert.equal(typeof mod.hashKey, "function");
  assert.equal(typeof mod.safeEqual, "function");
  assert.equal(typeof mod.genApiKey, "function");
  assert.equal(typeof mod.genOwnerKey, "function");
});

test("Module loading — lib/time", () => {
  const mod = require(path.join(ROOT, "lib/time"));
  assert.equal(typeof mod.formatALDate, "function");
  assert.equal(typeof mod.getTodayAL, "function");
  assert.equal(typeof mod.normalizeTimeHHMI, "function");
});

test("Module loading — lib/notifications", () => {
  const mod = require(path.join(ROOT, "lib/notifications"));
  assert.equal(typeof mod.sendMakeEvent, "function");
  assert.equal(typeof mod.fireMakeEvent, "function");
  assert.equal(typeof mod.fireFeedbackRequest, "function");
});

test("Module loading — lib/status", () => {
  const mod = require(path.join(ROOT, "lib/status"));
  assert.equal(typeof mod.getRestaurantRules, "function");
  assert.equal(typeof mod.decideReservationStatus, "function");
});

test("Module loading — lib/ratings", () => {
  const mod = require(path.join(ROOT, "lib/ratings"));
  assert.equal(typeof mod.toInt1to5, "function");
  assert.equal(typeof mod.normalizeFeedbackRatings, "function");
  assert.equal(typeof mod.toBoolOrNull, "function");
  assert.equal(typeof mod.segmentFromDays, "function");
});

test("Module loading — lib/html", () => {
  const mod = require(path.join(ROOT, "lib/html"));
  assert.equal(typeof mod.htmlPage, "function");
});

test("Module loading — middleware/auth", () => {
  const mod = require(path.join(ROOT, "middleware/auth"));
  assert.equal(typeof mod.requireApiKey, "function");
  assert.equal(typeof mod.requireOwnerKey, "function");
  assert.equal(typeof mod.requireAdminKey, "function");
  assert.equal(typeof mod.requirePlan, "function");
});

test("Module loading — middleware/db", () => {
  const mod = require(path.join(ROOT, "middleware/db"));
  assert.equal(typeof mod.requireDbReady, "function");
  assert.equal(typeof mod.requireNotProduction, "function");
});

test("Module loading — middleware/security", () => {
  const mod = require(path.join(ROOT, "middleware/security"));
  assert.equal(typeof mod.reservationLimiter, "function");
  assert.equal(typeof mod.generalLimiter, "function");
  assert.equal(typeof mod.ownerLimiter, "function");
  assert.equal(typeof mod.loginLimiter, "function");
});

// middleware/validate — skipped: module not yet extracted from index.js

test("Module loading — routes/health", () => {
  const mod = require(path.join(ROOT, "routes/health"));
  assert.ok(mod && typeof mod === "function", "health router should be a function (Express router)");
});

test("Module loading — routes/webhook", () => {
  const mod = require(path.join(ROOT, "routes/webhook"));
  assert.ok(mod && typeof mod === "function");
});

test("Module loading — routes/auth", () => {
  const mod = require(path.join(ROOT, "routes/auth"));
  assert.ok(mod && typeof mod === "function");
});

test("Module loading — routes/clicklinks", () => {
  const mod = require(path.join(ROOT, "routes/clicklinks"));
  assert.ok(mod && typeof mod === "function");
});

// routes/public — skipped: routes still inline in index.js
// routes/owner — skipped: routes still inline in index.js

test("Module loading — routes/admin", () => {
  const mod = require(path.join(ROOT, "routes/admin"));
  assert.ok(mod && typeof mod === "function");
});

test("Module loading — routes/marketing", () => {
  const mod = require(path.join(ROOT, "routes/marketing"));
  assert.ok(mod && typeof mod === "function");
});

test("Module loading — routes/debug", () => {
  const mod = require(path.join(ROOT, "routes/debug"));
  assert.ok(mod && typeof mod === "function");
});

test("Module loading — routes/pages", () => {
  const mod = require(path.join(ROOT, "routes/pages"));
  assert.ok(mod && typeof mod === "function");
});

// ─────────────────────────────────────────────────────────
// 3. HEALTH ENDPOINT TESTS  (minimal Express app, no DB)
// ─────────────────────────────────────────────────────────
test("GET / returns 200 with 'Te Ta' in body", async () => {
  const express = require("express");
  const healthRouter = require(path.join(ROOT, "routes/health"));

  const app = express();
  app.use(express.json());
  app.use("/", healthRouter);

  await withServer(app, async (server) => {
    const res = await request(server, { path: "/" });
    assert.equal(res.status, 200);
    assert.ok(
      res.text.includes("Te Ta"),
      `Expected body to contain 'Te Ta', got: ${res.text.slice(0, 120)}`
    );
  });
});

test("GET /health returns JSON with success:true", async () => {
  const express = require("express");
  const healthRouter = require(path.join(ROOT, "routes/health"));

  const app = express();
  app.use(express.json());
  app.use("/", healthRouter);

  await withServer(app, async (server) => {
    const res = await request(server, { path: "/health" });
    assert.equal(res.status, 200);
    assert.ok(res.json, "Response should be valid JSON");
    assert.equal(res.json.success, true);
    assert.ok("version" in res.json, "Response should include version");
  });
});

// ─────────────────────────────────────────────────────────
// 4. AUTH MIDDLEWARE TESTS
// ─────────────────────────────────────────────────────────

// Build a tiny Express app with a guarded route for auth testing
function buildAuthTestApp() {
  const express = require("express");
  const { requireApiKey, requireOwnerKey, requireAdminKey } = require(path.join(ROOT, "middleware/auth"));

  const app = express();
  app.use(express.json());

  app.get("/api-protected", requireApiKey, (req, res) => {
    res.json({ success: true, restaurant_id: req.restaurant_id });
  });
  app.get("/owner-protected", requireOwnerKey, (req, res) => {
    res.json({ success: true, restaurant_id: req.restaurant_id });
  });
  app.get("/admin-protected", requireAdminKey, (req, res) => {
    res.json({ success: true });
  });

  return app;
}

test("Auth middleware — missing x-api-key returns 401", async () => {
  const app = buildAuthTestApp();
  await withServer(app, async (server) => {
    const res = await request(server, { path: "/api-protected" });
    assert.equal(res.status, 401);
    assert.ok(res.json, "Should return JSON");
    assert.equal(res.json.success, false);
    assert.ok(
      res.json.error.toLowerCase().includes("missing"),
      `Expected 'missing' in error, got: ${res.json.error}`
    );
  });
});

test("Auth middleware — missing x-owner-key returns 401", async () => {
  const app = buildAuthTestApp();
  await withServer(app, async (server) => {
    const res = await request(server, { path: "/owner-protected" });
    assert.equal(res.status, 401);
    assert.equal(res.json.success, false);
    assert.ok(
      res.json.error.toLowerCase().includes("missing"),
      `Expected 'missing' in error, got: ${res.json.error}`
    );
  });
});

test("Auth middleware — missing x-admin-key returns 401", async () => {
  const app = buildAuthTestApp();
  await withServer(app, async (server) => {
    const res = await request(server, { path: "/admin-protected" });
    assert.equal(res.status, 401);
    assert.equal(res.json.success, false);
    assert.ok(
      res.json.error.toLowerCase().includes("missing"),
      `Expected 'missing' in error, got: ${res.json.error}`
    );
  });
});

test("Auth middleware — valid API_KEY env var is accepted (master key bypass)", async () => {
  const app = buildAuthTestApp();
  await withServer(app, async (server) => {
    const res = await request(server, {
      path: "/api-protected",
      headers: { "x-api-key": process.env.API_KEY },
    });
    // Master key matches env → next() is called → 200
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
  });
});

test("Auth middleware — valid ADMIN_KEY env var is accepted", async () => {
  const app = buildAuthTestApp();
  await withServer(app, async (server) => {
    const res = await request(server, {
      path: "/admin-protected",
      headers: { "x-admin-key": process.env.ADMIN_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
  });
});

// ─────────────────────────────────────────────────────────
// 5. RESERVATION INPUT VALIDATION TESTS (field-level via lib/time)
// ─────────────────────────────────────────────────────────

test("Reservation validation — normalizeTimeHHMI rejects bad times for reservations", () => {
  const { normalizeTimeHHMI } = require(path.join(ROOT, "lib/time"));
  // These are the same checks the POST /reservations handler does
  assert.equal(normalizeTimeHHMI("19:00"), "19:00", "Valid dinner time");
  assert.equal(normalizeTimeHHMI("9:30"), "09:30", "Single-digit hour normalized");
  assert.equal(normalizeTimeHHMI("25:00"), null, "Hour > 23 rejected");
  assert.equal(normalizeTimeHHMI("abc"), null, "Non-numeric rejected");
  assert.equal(normalizeTimeHHMI(""), null, "Empty rejected");
});

test("Reservation validation — date format YYYY-MM-DD regex", () => {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  assert.ok(dateRe.test("2026-05-01"), "Valid date format");
  assert.ok(!dateRe.test("01-05-2026"), "DD-MM-YYYY rejected");
  assert.ok(!dateRe.test("2026/05/01"), "Slash format rejected");
  assert.ok(!dateRe.test(""), "Empty rejected");
});

test("Reservation validation — people must be positive integer", () => {
  // Mirrors the inline validation in POST /reservations
  function validatePeople(val) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0;
  }
  assert.ok(validatePeople(2), "2 is valid");
  assert.ok(validatePeople("4"), "String '4' coerces to valid");
  assert.ok(!validatePeople(0), "0 is invalid");
  assert.ok(!validatePeople(-1), "Negative is invalid");
  assert.ok(!validatePeople("abc"), "Non-numeric is invalid");
  assert.ok(!validatePeople(NaN), "NaN is invalid");
});

// ─────────────────────────────────────────────────────────
// 6. RATE LIMITER EXISTENCE TESTS
// ─────────────────────────────────────────────────────────
test("Rate limiters — all 4 exported and are functions (middleware)", () => {
  const security = require(path.join(ROOT, "middleware/security"));
  const limiters = ["reservationLimiter", "generalLimiter", "ownerLimiter", "loginLimiter"];
  for (const name of limiters) {
    assert.equal(
      typeof security[name],
      "function",
      `${name} should be a function (Express middleware)`
    );
    // Express middleware must accept (req, res, next)
    assert.equal(
      security[name].length,
      3,
      `${name} should have arity 3 (req, res, next)`
    );
  }
});

// ─────────────────────────────────────────────────────────
// 7. LIB FUNCTION UNIT TESTS
// ─────────────────────────────────────────────────────────

test("lib/auth — hashKey returns consistent hex string", () => {
  const { hashKey } = require(path.join(ROOT, "lib/auth"));
  const h1 = hashKey("my-secret");
  const h2 = hashKey("my-secret");
  assert.equal(h1, h2, "Same input must produce same hash");
  assert.match(h1, /^[a-f0-9]{64}$/, "Hash should be 64-char hex (SHA-256)");
});

test("lib/auth — hashKey produces different hashes for different inputs", () => {
  const { hashKey } = require(path.join(ROOT, "lib/auth"));
  assert.notEqual(hashKey("key-A"), hashKey("key-B"));
});

test("lib/auth — safeEqual returns true for identical strings", () => {
  const { safeEqual } = require(path.join(ROOT, "lib/auth"));
  assert.equal(safeEqual("hello", "hello"), true);
});

test("lib/auth — safeEqual returns false for different strings", () => {
  const { safeEqual } = require(path.join(ROOT, "lib/auth"));
  assert.equal(safeEqual("hello", "world"), false);
});

test("lib/auth — safeEqual returns false for empty vs non-empty", () => {
  const { safeEqual } = require(path.join(ROOT, "lib/auth"));
  assert.equal(safeEqual("", "anything"), false);
  assert.equal(safeEqual("anything", ""), false);
});

test("lib/auth — genApiKey generates unique keys with correct prefix", () => {
  const { genApiKey } = require(path.join(ROOT, "lib/auth"));
  const k1 = genApiKey();
  const k2 = genApiKey();
  assert.ok(k1.startsWith("tta_api_key_"), "API key should start with tta_api_key_");
  assert.notEqual(k1, k2, "Each generated key should be unique");
});

test("lib/time — formatALDate returns a string for a valid date", () => {
  const { formatALDate } = require(path.join(ROOT, "lib/time"));
  const result = formatALDate("2026-05-01T19:00:00Z");
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0, "formatALDate should return non-empty string");
});

test("lib/time — formatALDate returns null for null input", () => {
  const { formatALDate } = require(path.join(ROOT, "lib/time"));
  assert.equal(formatALDate(null), null);
  assert.equal(formatALDate(undefined), null);
});

test("lib/time — normalizeTimeHHMI normalizes valid time strings", () => {
  const { normalizeTimeHHMI } = require(path.join(ROOT, "lib/time"));
  assert.equal(normalizeTimeHHMI("9:30"), "09:30");
  assert.equal(normalizeTimeHHMI("19:00"), "19:00");
  assert.equal(normalizeTimeHHMI("00:00"), "00:00");
  assert.equal(normalizeTimeHHMI("23:59"), "23:59");
});

test("lib/time — normalizeTimeHHMI returns null for invalid input", () => {
  const { normalizeTimeHHMI } = require(path.join(ROOT, "lib/time"));
  assert.equal(normalizeTimeHHMI("25:00"), null, "Hour > 23 should be null");
  assert.equal(normalizeTimeHHMI("10:60"), null, "Minute > 59 should be null");
  assert.equal(normalizeTimeHHMI(""), null);
  assert.equal(normalizeTimeHHMI(null), null);
  assert.equal(normalizeTimeHHMI("abc"), null);
});

test("lib/time — toYMD trims to YYYY-MM-DD", () => {
  const { toYMD } = require(path.join(ROOT, "lib/time"));
  assert.equal(toYMD("2026-05-01T19:00:00Z"), "2026-05-01");
  assert.equal(toYMD("2026-12-31"), "2026-12-31");
  assert.equal(toYMD(null), "");
  assert.equal(toYMD(""), "");
});

test("lib/html — htmlPage returns HTML string with correct title", () => {
  const { htmlPage } = require(path.join(ROOT, "lib/html"));
  const html = htmlPage("Test Title", "Some message");
  assert.equal(typeof html, "string");
  assert.ok(html.includes("<!doctype html>"), "Should be valid HTML");
  assert.ok(html.includes("Test Title"), "Should contain title");
  assert.ok(html.includes("Some message"), "Should contain message");
});

test("lib/ratings — toInt1to5 clamps correctly", () => {
  const { toInt1to5 } = require(path.join(ROOT, "lib/ratings"));
  assert.equal(toInt1to5(1), 1);
  assert.equal(toInt1to5(5), 5);
  assert.equal(toInt1to5(3), 3);
  assert.equal(toInt1to5(0), null, "0 should be out of range");
  assert.equal(toInt1to5(6), null, "6 should be out of range");
  assert.equal(toInt1to5("abc"), null, "Non-numeric should be null");
});

test("lib/ratings — segmentFromDays classifies correctly", () => {
  const { segmentFromDays } = require(path.join(ROOT, "lib/ratings"));
  assert.equal(segmentFromDays(0), "ACTIVE");
  assert.equal(segmentFromDays(14), "ACTIVE");
  assert.equal(segmentFromDays(15), "WARM");
  assert.equal(segmentFromDays(30), "WARM");
  assert.equal(segmentFromDays(31), "COLD");
  assert.equal(segmentFromDays(null), "UNKNOWN");
  assert.equal(segmentFromDays("x"), "UNKNOWN");
});

test("lib/ratings — toBoolOrNull parses truthy/falsy strings", () => {
  const { toBoolOrNull } = require(path.join(ROOT, "lib/ratings"));
  assert.equal(toBoolOrNull(true), true);
  assert.equal(toBoolOrNull("true"), true);
  assert.equal(toBoolOrNull("1"), true);
  assert.equal(toBoolOrNull("po"), true);
  assert.equal(toBoolOrNull(false), false);
  assert.equal(toBoolOrNull("false"), false);
  assert.equal(toBoolOrNull("jo"), false);
  assert.equal(toBoolOrNull(null), null);
  assert.equal(toBoolOrNull(undefined), null);
  assert.equal(toBoolOrNull("maybe"), null);
});

// ─────────────────────────────────────────────────────────
// 8. MIDDLEWARE/DB BEHAVIOR TESTS
// ─────────────────────────────────────────────────────────
test("middleware/db — requireDbReady blocks when DB_READY=false", async () => {
  const express = require("express");
  const state = require(path.join(ROOT, "lib/state"));
  const { requireDbReady } = require(path.join(ROOT, "middleware/db"));

  const originalReady = state.DB_READY;
  state.DB_READY = false;

  const app = express();
  app.use(express.json());
  app.get("/test", requireDbReady, (req, res) => res.json({ success: true }));

  await withServer(app, async (server) => {
    const res = await request(server, { path: "/test" });
    assert.equal(res.status, 503);
    assert.equal(res.json.success, false);
  });

  state.DB_READY = originalReady;
});

test("middleware/db — requireDbReady passes when DB_READY=true", async () => {
  const express = require("express");
  const state = require(path.join(ROOT, "lib/state"));
  const { requireDbReady } = require(path.join(ROOT, "middleware/db"));

  const originalReady = state.DB_READY;
  state.DB_READY = true;

  const app = express();
  app.use(express.json());
  app.get("/test", requireDbReady, (req, res) => res.json({ success: true }));

  await withServer(app, async (server) => {
    const res = await request(server, { path: "/test" });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
  });

  state.DB_READY = originalReady;
});

test("middleware/db — requireNotProduction blocks in production env", async () => {
  const express = require("express");
  const { requireNotProduction } = require(path.join(ROOT, "middleware/db"));

  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const app = express();
  app.use(express.json());
  app.get("/debug", requireNotProduction, (req, res) => res.json({ success: true }));

  await withServer(app, async (server) => {
    const res = await request(server, { path: "/debug" });
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
  });

  process.env.NODE_ENV = originalEnv;
});

// ─────────────────────────────────────────────────────────
// 9. CONFIG CONSTANTS INTEGRITY TEST
// ─────────────────────────────────────────────────────────
test("config/constants — APP_VERSION matches expected pattern", () => {
  const { APP_VERSION } = require(path.join(ROOT, "config/constants"));
  // Pattern: v-YYYY-MM-DD-... or v-YYYY-MM-DD
  assert.match(
    APP_VERSION,
    /^v-\d{4}-\d{2}-\d{2}/,
    `APP_VERSION '${APP_VERSION}' should start with v-YYYY-MM-DD`
  );
});

// ─────────────────────────────────────────────────────────
// 10. PIN LOGIN ENDPOINT TESTS (routes/auth.js)
// ─────────────────────────────────────────────────────────

function buildPinLoginApp() {
  const express = require("express");
  const state = require(path.join(ROOT, "lib/state"));
  state.DB_READY = true;

  const authRouter = require(path.join(ROOT, "routes/auth"));
  const app = express();
  app.use(express.json());
  app.use("/", authRouter);
  return app;
}

test("PIN login — missing pin returns 400", async () => {
  const app = buildPinLoginApp();
  await withServer(app, async (server) => {
    const res = await request(server, {
      path: "/auth/pin-login",
      method: "POST",
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.json.error, "Should return error message");
  });
});

test("PIN login — invalid pin returns 401", async () => {
  const app = buildPinLoginApp();
  await withServer(app, async (server) => {
    const res = await request(server, {
      path: "/auth/pin-login",
      method: "POST",
      body: { pin: "9999" },
    });
    assert.equal(res.status, 401);
    assert.ok(res.json.error, "Should return error for wrong PIN");
  });
});

test("PIN login — valid pin returns owner_key and restaurant info", async () => {
  const app = buildPinLoginApp();
  await withServer(app, async (server) => {
    const res = await request(server, {
      path: "/auth/pin-login",
      method: "POST",
      body: { pin: "1234" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.ok(res.json.owner_key, "Should return owner_key");
    assert.ok(res.json.owner_key.startsWith("own_"), "owner_key should start with own_");
    assert.equal(res.json.restaurant_id, 1);
    assert.equal(res.json.restaurant_name, "Test Restaurant");
  });
});

// ─────────────────────────────────────────────────────────
// 11. RESERVATION LOGIC TESTS (lib/status + lib/time)
// ─────────────────────────────────────────────────────────

test("lib/status — getRestaurantRules returns valid defaults", async () => {
  const { getRestaurantRules } = require(path.join(ROOT, "lib/status"));
  const rules = await getRestaurantRules(1);
  assert.equal(typeof rules.maxPeople, "number");
  assert.ok(rules.maxPeople > 0, "maxPeople should be positive");
  assert.match(rules.openingStart, /^\d{2}:\d{2}$/);
  assert.match(rules.openingEnd, /^\d{2}:\d{2}$/);
  assert.match(rules.cutoffHHMI, /^\d{2}:\d{2}$/);
  assert.ok(rules.maxCapacity > 0, "maxCapacity should be positive");
});

test("lib/status — decideReservationStatus auto-confirms future date", async () => {
  const { decideReservationStatus } = require(path.join(ROOT, "lib/status"));
  // Use a date far in the future — never "today"
  const result = await decideReservationStatus(1, "2099-12-31", 2);
  assert.equal(result.status, "Confirmed");
  assert.equal(result.reason, "future_auto_confirm");
  assert.equal(result.isTodayAL, false);
});

test("lib/status — decideReservationStatus marks large groups as Pending", async () => {
  const { decideReservationStatus } = require(path.join(ROOT, "lib/status"));
  // 100 people exceeds any threshold
  const result = await decideReservationStatus(1, "2099-12-31", 100);
  assert.equal(result.status, "Pending");
  assert.equal(result.reason, "group_over_threshold");
});

test("lib/time — rejectIfTimePassedTodayAL accepts future date", async () => {
  const { rejectIfTimePassedTodayAL } = require(path.join(ROOT, "lib/time"));
  const result = await rejectIfTimePassedTodayAL("2099-12-31", "19:00");
  assert.equal(result.ok, true);
  assert.equal(result.timeHHMI, "19:00");
});

test("lib/time — rejectIfTimePassedTodayAL rejects invalid time", async () => {
  const { rejectIfTimePassedTodayAL } = require(path.join(ROOT, "lib/time"));
  const result = await rejectIfTimePassedTodayAL("2099-12-31", "25:00");
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "INVALID_TIME");
});

test("lib/time — subtractMinutesHHMI works correctly", () => {
  const { subtractMinutesHHMI } = require(path.join(ROOT, "lib/time"));
  assert.equal(subtractMinutesHHMI("14:30", 30), "14:00");
  assert.equal(subtractMinutesHHMI("14:00", 90), "12:30");
  assert.equal(subtractMinutesHHMI("01:00", 120), "00:00"); // clamps to 0
  assert.equal(subtractMinutesHHMI("00:00", 10), "00:00");  // clamps to 0
});

test("lib/time — isTimePassedTodayAL returns false for future date", async () => {
  const { isTimePassedTodayAL } = require(path.join(ROOT, "lib/time"));
  const result = await isTimePassedTodayAL("2099-12-31", "19:00");
  assert.equal(result, false);
});

test("lib/time — isTimePassedTodayAL returns true for past time today", async () => {
  const { isTimePassedTodayAL } = require(path.join(ROOT, "lib/time"));
  // Mock returns today as 2026-04-07 and now_hhmi as 10:00
  const result = await isTimePassedTodayAL("2026-04-07", "09:00");
  assert.equal(result, true, "09:00 should be past when now is 10:00");
});

test("lib/time — isTimePassedTodayAL returns false for future time today", async () => {
  const { isTimePassedTodayAL } = require(path.join(ROOT, "lib/time"));
  // Mock returns now_hhmi as 10:00
  const result = await isTimePassedTodayAL("2026-04-07", "19:00");
  assert.equal(result, false, "19:00 should not be past when now is 10:00");
});
