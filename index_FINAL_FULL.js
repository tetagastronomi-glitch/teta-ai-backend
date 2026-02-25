/**
 * const axios = require('axios');
 * index.js (FINAL - MULTI-RESTAURANT + ADMIN + PLANS + OWNER ALERTS + CONFIRM/DECLINE EVENTS + CLICK LINKS)
 * Te Ta AI Backend — Reservations + Feedback + Events(CORE) + Reports (Today)
 * + CRM Customers + Consents (LEGAL) + Owner View (read-only via OWNER_KEY table)
 * + Segments (premium) + Audience Export (premium)
 *
 * ✅ SaaS Mode:
 * - x-api-key validated from DB table public.api_keys (hashed)
 * - x-owner-key validated from DB table public.owner_keys (hashed)
 * - restaurant_id comes from key => req.restaurant_id
 *
 * ✅ Admin Mode:
 * - x-admin-key validated from env ADMIN_KEY (raw compare via safeEqual)
 * - create restaurants, rotate keys, disable keys, set plan
 *
 * ✅ Owner Alerts:
 * - Make webhook (one webhook for all events), routed by `type`
 * - reservation_created (Pending Today AL / or Pending by people threshold)
 * - reservation_confirmed (auto-confirmed or owner confirmed)
 * - reservation_declined (owner declined)
 *
 * ✅ Owner Click Links (NO HEADERS):
 * - /o/confirm/:token
 * - /o/decline/:token
 * - token stored in DB (owner_action_tokens), expires, single-use
 */

require("dotenv").config({ override: true });
process.env.TZ = "Europe/Tirane";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

// ==================== HTTP CLIENT (AXIOS OPTIONAL) ====================
// This keeps compatibility with older code that uses axios(), without requiring axios as a dependency.
let axios;
try {
  axios = require("axios");
} catch (e) {
  axios = async function axiosLike(config) {
    const method = String(config?.method || "GET").toUpperCase();
    const url = String(config?.url || "");
    const headers = Object.assign({}, config?.headers || {});
    let body = undefined;
    if (config?.data !== undefined) {
      body = JSON.stringify(config.data);
      if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
    }
    const _fetch = async (u, opts) => {
      if (typeof fetch === "function") return fetch(u, opts);
      const mod = await import("node-fetch");
      return mod.default(u, opts);
    };
    const r = await _fetch(url, { method, headers, body });
    const text = await r.text().catch(() => "");
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    if (!r.ok) {
      const err = new Error("HTTP " + r.status);
      err.response = { status: r.status, data };
      throw err;
    }
    return { status: r.status, data };
  };
}


const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/webhook", (req, res, next) => next());
// ✅ MOD: default e bëmë 4 (më realist), por env e mbivendos
const MAX_AUTO_CONFIRM_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 4);

// ✅ version marker (ndryshoje kur bën deploy)
const APP_VERSION = "v-2026-02-04-close-cycle-1";

// ==================== DB READY FLAG ====================
let DB_READY = false;

async function testDbConnection() {
  try {
    const r = await pool.query("SELECT 1 as ok");
    return r.rows[0]?.ok === 1;
  } catch (_) {
    return false;
  }
}

function requireDbReady(req, res, next) {
  if (!DB_READY) {
    return res.status(503).json({
      success: false,
      version: APP_VERSION,
      error: "DB not reachable. Check DATABASE_URL / network.",
    });
  }
  next();
}

// ==================== TIME HELPERS (FINAL - SAFE) ====================
// Assumes you already have: const pool = new Pool({ ... })

function formatALDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleString("sq-AL", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ✅ Helper: get "today" in Albania date as YYYY-MM-DD string (server-agnostic)
// NOTE: async => MUST be used with await
async function getTodayAL() {
  const q = await pool.query(`
    SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date, 'YYYY-MM-DD') AS d
  `);
  return String(q.rows?.[0]?.d || "").trim(); // "YYYY-MM-DD"
}

// ✅ Helper: normalize any date input to YYYY-MM-DD string (safe)
function toYMD(x) {
  if (!x) return "";
  return String(x).trim().slice(0, 10);
}

// ✅ Helper: is reservation date = today (Europe/Tirane) – SAFE STRING compare
async function isReservationTodayAL(reservationDate) {
  const todayYMD = await getTodayAL();
  const reqYMD = toYMD(reservationDate);
  return reqYMD === todayYMD;
}

// ✅ Helper: normalize HH:MI (returns null if invalid)
function normalizeTimeHHMI(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);

  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;

  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

// ✅ Helper: get "now" time in Albania as HH:MI string (server-agnostic)
// NOTE: async => MUST be used with await
async function getNowHHMI_AL() {
  const q = await pool.query(`
    SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::time, 'HH24:MI') AS now_hhmi
  `);
  // ensure always HH:MI
  return normalizeTimeHHMI(q.rows?.[0]?.now_hhmi) || "00:00";
}

// ✅ Helper: per-restaurant rules (fallback to env defaults)
async function getRestaurantRules(restaurant_id) {
  const DEFAULT_MAX_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 6);
  const DEFAULT_CUTOFF = String(process.env.SAME_DAY_CUTOFF_HHMI || "11:00").trim();

  try {
    const q = await pool.query(
      `
      SELECT max_auto_confirm_people, same_day_cutoff_hhmi
      FROM public.restaurants
      WHERE id = $1
      LIMIT 1;
      `,
      [restaurant_id]
    );

    const row = q.rows?.[0] || {};
    const maxPeopleRaw = Number(row.max_auto_confirm_people ?? DEFAULT_MAX_PEOPLE);
    const cutoffRaw = String(row.same_day_cutoff_hhmi ?? DEFAULT_CUTOFF).trim();

    const maxPeople =
      Number.isFinite(maxPeopleRaw) && maxPeopleRaw > 0 ? maxPeopleRaw : DEFAULT_MAX_PEOPLE;

    const cutoffHHMI = normalizeTimeHHMI(cutoffRaw) || normalizeTimeHHMI(DEFAULT_CUTOFF) || "11:00";

    return { maxPeople, cutoffHHMI };
  } catch (e) {
    return {
      maxPeople: Number.isFinite(DEFAULT_MAX_PEOPLE) && DEFAULT_MAX_PEOPLE > 0 ? DEFAULT_MAX_PEOPLE : 6,
      cutoffHHMI: normalizeTimeHHMI(DEFAULT_CUTOFF) || "11:00",
    };
  }
}

// ✅ Helper: returns true if reservation is for TODAY and time has already passed (Europe/Tirane)
async function isTimePassedTodayAL(reservationDate, reservationTimeHHMI) {
  const reqYMD = toYMD(reservationDate);
  const todayYMD = await getTodayAL();
  if (reqYMD !== todayYMD) return false;

  const timeHHMI = normalizeTimeHHMI(reservationTimeHHMI);
  if (!timeHHMI) return false;

  const nowHHMI = await getNowHHMI_AL();

  // String compare works because both are zero-padded "HH:MI"
  return timeHHMI < nowHHMI;
}

// ✅ Helper: enforce "reject if time passed today" with your exact user-facing message
async function rejectIfTimePassedTodayAL(reservationDate, rawTime) {
  const timeHHMI = normalizeTimeHHMI(rawTime);
  if (!timeHHMI) {
    return {
      ok: false,
      error_code: "INVALID_TIME",
      message: "Ora është e pavlefshme.",
    };
  }

  const passed = await isTimePassedTodayAL(reservationDate, timeHHMI);
  if (passed) {
    return {
      ok: false,
      error_code: "TIME_PASSED",
      message:
        "Ora që ke zgjedhur ka kaluar.\nTë lutem zgjidh një orë tjetër sot ose një ditë tjetër.",
    };
  }

  return { ok: true, timeHHMI };
}

// ✅ Helper: subtract minutes from HH:MI safely (never returns invalid)
function subtractMinutesHHMI(hhmi, minutes) {
  const t = normalizeTimeHHMI(hhmi) || "00:00";
  const mins = Number(minutes);
  const safeMins = Number.isFinite(mins) && mins >= 0 ? Math.floor(mins) : 0;

  const [h, m] = t.split(":").map(Number);
  let total = h * 60 + m - safeMins;

  if (!Number.isFinite(total) || total < 0) total = 0;
  if (total > 23 * 60 + 59) total = 23 * 60 + 59;

  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}


// ==================== ✅ STATUS RULE (CENTRALIZED) — FIXED ====================
// RREGULLI FINAL (siç the ti):
// - SOT:
//    - Pending nëse (now >= 11:00) OSE people > MAX_AUTO_CONFIRM_PEOPLE
//    - përndryshe Confirmed
// - NË TË ARDHMEN:
//    - Pending vetëm nëse people > MAX_AUTO_CONFIRM_PEOPLE
//    - përndryshe Confirmed
//
// NOTE: Cutoff dhe threshold do bëhen "per business" më vonë; tani janë globale.
async function decideReservationStatus(restaurantId, dateStr, people) {
  const isTodayAL = await isReservationTodayAL(dateStr);

  // ✅ per-business rules (SaaS): read from restaurants table, fallback to env
  const rules = await getRestaurantRules(restaurantId);
  const p = Number(people);
  const maxPeople = Number(rules.maxPeople);
  const cutoffHHMI = String(rules.cutoffHHMI || "11:00").trim();

  // grupet => gjithmonë Pending
  if (Number.isFinite(p) && Number.isFinite(maxPeople) && p > maxPeople) {
    return { isTodayAL, status: "Pending", reason: "group_over_threshold" };
  }

  if (isTodayAL) {
    const nowHHMI = await getNowHHMI_AL();

    const cutoffOk = /^(\d{2}):(\d{2})$/.test(cutoffHHMI);
    if (!cutoffOk) return { isTodayAL: true, status: "Pending", reason: "cutoff_invalid_failsafe" };

    if (nowHHMI >= cutoffHHMI) return { isTodayAL: true, status: "Pending", reason: "same_day_after_cutoff" };

    return { isTodayAL: true, status: "Confirmed", reason: "same_day_before_cutoff" };
  }

  return { isTodayAL: false, status: "Confirmed", reason: "future_auto_confirm" };
}



// ==================== MAKE EVENT SENDER ====================

// ✅ Node 18+ has global fetch. If not, lazy-load node-fetch (works on Node 16 too).
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

// ✅ Feedback request wrapper (owner-controlled)
function fireFeedbackRequest(payload) {
  fireMakeEvent("feedback_request", payload);
}

// ==================== AUTH HELPERS (HASH + SAFE EQUAL) ====================
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

// Generate raw keys (NEVER store raw in DB)
function genApiKey() {
  return "tta_api_key_" + crypto.randomBytes(16).toString("hex");
}
function genOwnerKey() {
  return "tta_owner_key_" + crypto.randomBytes(16).toString("hex");
}

// ==================== AUTH MIDDLEWARES (ONLY ONCE) ====================
async function requireApiKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-api-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Missing x-api-key",
      });
    }

    // 🔵 SHTESË (NUK HEQ ASGJË)
    // Lejo master API key nga .env për ops / health / cron
    const master = String(process.env.API_KEY || "").trim();
    if (master && safeEqual(rawKey, master)) {
      // vendos kontekst restoranti vetëm për ops lokale
      const rid = Number(process.env.RESTAURANT_ID || 0);
      req.restaurant_id = Number.isFinite(rid) && rid > 0 ? rid : null;
      return next();
    }
    // 🔵 FUND SHTESE

    const keyHash = hashKey(rawKey);

    const q = `
      SELECT restaurant_id
      FROM public.api_keys
      WHERE key_hash = $1 AND is_active = TRUE
      LIMIT 1;
    `;
    const r = await pool.query(q, [keyHash]);

    if (r.rows.length === 0) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Invalid api key",
      });
    }

    req.restaurant_id = Number(r.rows[0].restaurant_id);
    pool.query(`UPDATE public.api_keys SET last_used_at = NOW() WHERE key_hash = $1;`, [keyHash]).catch(() => {});
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Auth failed",
    });
  }
}

async function requireOwnerKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-owner-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Missing x-owner-key",
      });
    }

    const keyHash = hashKey(rawKey);

    const q = `
      SELECT restaurant_id
      FROM public.owner_keys
      WHERE key_hash = $1 AND is_active = TRUE
      LIMIT 1;
    `;
    const r = await pool.query(q, [keyHash]);

    if (r.rows.length === 0) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Invalid owner key",
      });
    }

    req.restaurant_id = Number(r.rows[0].restaurant_id);
    pool.query(`UPDATE public.owner_keys SET last_used_at = NOW() WHERE key_hash = $1;`, [keyHash]).catch(() => {});
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Owner auth failed",
    });
  }
}

// ✅ FIX: removed stray characters, keep original logic
async function requireAdminKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-admin-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Missing x-admin-key",
      });
    }

    const expected = String(process.env.ADMIN_KEY || "").trim();
    if (!expected) {
      // Admin endpoints disabled until ADMIN_KEY is configured (prevents weird behavior)
      return res.status(503).json({
        success: false,
        version: APP_VERSION,
        error: "ADMIN endpoints disabled (ADMIN_KEY not configured)",
      });
    }

    if (!safeEqual(rawKey, expected)) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Invalid admin key",
      });
    }

    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Admin auth failed",
    });
  }
}

// ==================== PLANS (FREE/PRO) ====================
function requirePlan(requiredPlan) {
  return async (req, res, next) => {
    try {
      const q = await pool.query(`SELECT plan FROM public.restaurants WHERE id=$1 LIMIT 1;`, [req.restaurant_id]);
      const plan = String(q.rows[0]?.plan || "FREE").toUpperCase();
      const need = String(requiredPlan || "FREE").toUpperCase();

      const rank = (p) => (p === "PRO" ? 2 : 1);
      if (rank(plan) < rank(need)) {
        return res.status(403).json({
          success: false,
          version: APP_VERSION,
          restaurant_id: req.restaurant_id,
          error: `Plan required: ${need}. Current: ${plan}`,
        });
      }

      req.plan = plan;
      next();
    } catch (err) {
      return res.status(500).json({
        success: false,
        version: APP_VERSION,
        restaurant_id: req.restaurant_id,
        error: "Plan check failed",
      });
    }
  };
}

// ==================== INIT / MIGRATIONS ====================
async function initDb() {
  try {
    // restaurants
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.restaurants (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ✅ owner_phone (for WhatsApp routing) — always present, safe migration
    // 1) Add column if missing
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS owner_phone TEXT;
    `);

    // 2) Set default first (so new rows get it)
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN owner_phone SET DEFAULT '';
    `);

    // 3) Backfill any existing NULLs
    await pool.query(`
      UPDATE public.restaurants
      SET owner_phone = ''
      WHERE owner_phone IS NULL;
    `);

    // 4) Enforce NOT NULL (now safe)
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN owner_phone SET NOT NULL;
    `);

    // plan
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'FREE';
    `);

    // ✅ RESERVATION RULES (SaaS per-business)
    // max_auto_confirm_people
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS max_auto_confirm_people INT;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN max_auto_confirm_people SET DEFAULT 6;
    `);
    await pool.query(`
      UPDATE public.restaurants
      SET max_auto_confirm_people = 6
      WHERE max_auto_confirm_people IS NULL;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN max_auto_confirm_people SET NOT NULL;
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restaurants_max_auto_confirm_people') THEN
          ALTER TABLE public.restaurants
          ADD CONSTRAINT ck_restaurants_max_auto_confirm_people CHECK (max_auto_confirm_people BETWEEN 1 AND 50);
        END IF;
      END $$;
    `);

    // same_day_cutoff_hhmi
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS same_day_cutoff_hhmi TEXT;
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN same_day_cutoff_hhmi SET DEFAULT '11:00';
    `);
    await pool.query(`
      UPDATE public.restaurants
      SET same_day_cutoff_hhmi = '11:00'
      WHERE same_day_cutoff_hhmi IS NULL OR same_day_cutoff_hhmi = '';
    `);
    await pool.query(`
      ALTER TABLE public.restaurants
      ALTER COLUMN same_day_cutoff_hhmi SET NOT NULL;
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restaurants_same_day_cutoff_hhmi') THEN
          ALTER TABLE public.restaurants
          ADD CONSTRAINT ck_restaurants_same_day_cutoff_hhmi CHECK (same_day_cutoff_hhmi ~ '^\\d{2}:\\d{2}$');
        END IF;
      END $$;
    `);

    // ✅ FEEDBACK SETTINGS (OWNER-CONTROLLED)
    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_cooldown_days INT NOT NULL DEFAULT 10;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_batch_limit INT NOT NULL DEFAULT 30;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_exclude_frequent_over_visits INT NOT NULL DEFAULT 5;
    `);

    await pool.query(`
      ALTER TABLE public.restaurants
      ADD COLUMN IF NOT EXISTS feedback_template TEXT NOT NULL DEFAULT '';
    `);
// ✅ Close-cycle fields (safe)
await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);
await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS closed_reason TEXT DEFAULT '';`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_res_rest_closed_at ON public.reservations (restaurant_id, closed_at);`);

    // api_keys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        label TEXT DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

    // owner_keys
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.owner_keys (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        label TEXT DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

    // unique constraints on key_hash
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_api_keys_key_hash') THEN
          ALTER TABLE public.api_keys
          ADD CONSTRAINT uq_api_keys_key_hash UNIQUE (key_hash);
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_owner_keys_key_hash') THEN
          ALTER TABLE public.owner_keys
          ADD CONSTRAINT uq_owner_keys_key_hash UNIQUE (key_hash);
        END IF;
      END $$;
    `);

    // feedback
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.feedback (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi',
        phone TEXT NOT NULL,

        location_rating INT NOT NULL CHECK (location_rating BETWEEN 1 AND 5),
        hospitality_rating INT NOT NULL CHECK (hospitality_rating BETWEEN 1 AND 5),
        food_rating INT NOT NULL CHECK (food_rating BETWEEN 1 AND 5),
        price_rating INT NOT NULL CHECK (price_rating BETWEEN 1 AND 5),

        comment TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Optional: link feedback -> reservation (safe)
    await pool.query(`
      ALTER TABLE public.feedback
      ADD COLUMN IF NOT EXISTS reservation_id INTEGER;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_reservation_id
      ON public.feedback (reservation_id);
    `);

    // reservations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.reservations (
        id SERIAL PRIMARY KEY,
        restaurant_id INT REFERENCES public.restaurants(id) ON DELETE CASCADE,
        reservation_id TEXT,
        restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi',
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        date DATE NOT NULL,
        time TEXT NOT NULL,
        people INT NOT NULL,
        channel TEXT,
        area TEXT,
        first_time TEXT,
        allergies TEXT DEFAULT '',
        special_requests TEXT DEFAULT '',
        raw JSON,
        status TEXT NOT NULL DEFAULT 'Confirmed',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure columns exist (non-breaking)
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reservation_id TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS restaurant_id INT;`);
    await pool.query(
      `ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS restaurant_name TEXT NOT NULL DEFAULT 'Te Ta Gastronomi';`
    );
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS channel TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS area TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS first_time TEXT;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS allergies TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS special_requests TEXT DEFAULT '';`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS raw JSON;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Confirmed';`);

    // ✅ feedback anti-spam flags (safe)
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS feedback_requested_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS feedback_received_at TIMESTAMP;`);

    // FK (safe)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reservations_restaurant') THEN
          ALTER TABLE public.reservations
          ADD CONSTRAINT fk_reservations_restaurant
          FOREIGN KEY (restaurant_id)
          REFERENCES public.restaurants(id)
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    // ==================== CRM: CUSTOMERS + CONSENTS (LEGAL) ====================
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.customers (
        id BIGSERIAL PRIMARY KEY,
        restaurant_id BIGINT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

        phone TEXT NOT NULL,
        full_name TEXT,
        email TEXT,

        notes TEXT,
        tags TEXT[] DEFAULT ARRAY[]::TEXT[],

        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        visits_count INTEGER NOT NULL DEFAULT 0,

        -- CONSENTS
        consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
        consent_sms BOOLEAN NOT NULL DEFAULT FALSE,
        consent_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
        consent_email BOOLEAN NOT NULL DEFAULT FALSE,
        consent_source TEXT,
        consent_updated_at TIMESTAMPTZ,

        -- ✅ feedback cooldown tracking (safe)
        feedback_last_sent_at TIMESTAMP,
        feedback_last_received_at TIMESTAMP,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_customers_restaurant_phone UNIQUE (restaurant_id, phone)
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_restaurant_id ON public.customers(restaurant_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers(phone);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_last_seen ON public.customers(last_seen_at);`);

    await pool.query(`DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;`);
    await pool.query(`
      CREATE TRIGGER trg_customers_updated_at
      BEFORE UPDATE ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    `);

    // Owner views
    await pool.query(`
      CREATE OR REPLACE VIEW public.owner_customers AS
      SELECT
        id, restaurant_id, phone, full_name,
        visits_count, first_seen_at, last_seen_at,
        consent_marketing, consent_sms, consent_whatsapp, consent_email,
        created_at, updated_at
      FROM public.customers;
    `);

    await pool.query(`
      CREATE OR REPLACE VIEW public.owner_reservations AS
      SELECT
        id, restaurant_id, reservation_id,
        restaurant_name, customer_name, phone,
        date, time, people, channel, area,
        first_time, allergies, special_requests,
        status, created_at
      FROM public.reservations;
    `);

    // ==================== EVENTS (CORE) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.events (
        id SERIAL PRIMARY KEY,

        restaurant_id INTEGER NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        customer_id INTEGER NULL,

        reservation_id TEXT NULL,

        event_type VARCHAR(50) NOT NULL DEFAULT 'restaurant_reservation',
        event_date DATE NOT NULL,
        event_time TIME NOT NULL,

        people INTEGER,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',

        source VARCHAR(50),
        area VARCHAR(50),

        allergies TEXT,
        special_requests TEXT,
        notes TEXT,

        created_by VARCHAR(20) DEFAULT 'AI',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_restaurant_date
      ON public.events (restaurant_id, event_date);
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON public.events (status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_reservation_id ON public.events (reservation_id);`);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_res_rest_status_date
      ON public.reservations (restaurant_id, status, date);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_res_rest_phone_date
      ON public.reservations (restaurant_id, phone, date);
    `);

    // ==================== OWNER ACTION TOKENS (CLICK LINKS) ====================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.owner_action_tokens (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        reservation_id INT NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK (action IN ('confirm','decline')),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_owner_action_tokens_token ON public.owner_action_tokens(token);`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_owner_action_tokens_reservation ON public.owner_action_tokens(reservation_id);`
    );

    console.log("✅ DB ready (migrations applied)");
  } catch (err) {
    console.error("❌ initDb error:", err);
  }
}

// Boot DB (safe: server can still run even if DB down)
(async () => {
  const ok = await testDbConnection();
  if (!ok) {
    DB_READY = false;
    console.log("⚠️ DB not reachable right now. Server will run, DB endpoints will return 503 until DB is reachable.");
    return;
  }
  await initDb();
  DB_READY = true;
})();
// ✅ KËTU VENDOSET KODI I RI PËR WHATSAPP
app.get("/webhook", (req, res) => {
  const verify_token = "te_ta_ai_2026";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("✅ WEBHOOK_VERIFIED_BY_META");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  // 1. Ky bllok lexon mesazhin që vjen nga WhatsApp
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // 2. Kontrollojmë nëse kemi marrë një mesazh teksti
    if (message && message.type === "text") {
      const from = message.from; // Numri i telefonit të klientit
      const customerText = message.text.body; // Teksti që shkroi klienti

      console.log(`📩 Mesazh i ri nga ${from}: ${customerText}`);

      // 3. Kjo është përgjigjja që do të dërgojë roboti
      const aiResponse = "Përshëndetje! Ky është një mesazh automatik nga sistemi Te Ta AI. Sistemi yt është lidhur me sukses! 🚀";

      try {
        // 4. Dërgimi i përgjigjes mbrapsht te klienti duke përdorur Variablat e Railway
        await axios({
          method: "POST",
          url: `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          data: {
            messaging_product: "whatsapp",
            to: from,
            text: { body: aiResponse },
          },
          headers: { 
            "Authorization": `Bearer ${process.env.WA_TOKEN}`,
            "Content-Type": "application/json"
          },
        });
        console.log("✅ Përgjigjja u dërgua me sukses!");
      } catch (error) {
        // Nëse ka gabim, do e shohim te Railway Logs
        console.error("❌ Gabim gjatë dërgimit:", error.response?.data || error.message);
      }
    }
    return res.sendStatus(200);
  }
  res.sendStatus(404);
});
// ==================== HEALTH ====================
app.get("/", (req, res) => {
  res.status(200).send(`Te Ta Backend is running OK (${APP_VERSION})`);
});

app.get("/health/db", requireApiKey, async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    DB_READY = true;
    return res.json({
      success: true,
      db: "ok",
      version: APP_VERSION,
      now: r.rows[0].now,
      now_local: formatALDate(r.rows[0].now),
      restaurant_id: req.restaurant_id,
      max_auto_confirm_people: MAX_AUTO_CONFIRM_PEOPLE,
    });
  } catch (err) {
    DB_READY = false;
    return res.status(503).json({
      success: false,
      db: "down",
      version: APP_VERSION,
      error: err.message,
      restaurant_id: req.restaurant_id,
    });
  }
});

// ==================== DEBUG (DEV ONLY) ====================
function requireNotProduction(req, res, next) {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  if (env === "production") {
    return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });
  }
  next();
}

app.get("/debug/customers", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
  const q = await pool.query(
    `
    SELECT
      id,
      restaurant_id,
      phone,
      full_name,
      visits_count,
      first_seen_at,
      last_seen_at,
      created_at
    FROM public.customers
    WHERE restaurant_id = $1
    ORDER BY id DESC
    LIMIT 20;
    `,
    [req.restaurant_id]
  );

  return res.json({
    success: true,
    version: APP_VERSION,
    restaurant_id: req.restaurant_id,
    count: q.rows.length,
    data: q.rows,
  });
});

app.get("/debug/reservations-schema", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
  const q = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reservations'
    ORDER BY ordinal_position;
  `);
  return res.json({ success: true, version: APP_VERSION, columns: q.rows });
});

app.get("/debug/reservations-constraints", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = con.connamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = 'reservations'
      ORDER BY con.conname;
    `);
    return res.json({ success: true, version: APP_VERSION, constraints: q.rows });
  } catch (err) {
    console.error("❌ /debug/reservations-constraints error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== ADMIN (PLATFORM OWNER) ====================
// (ke edhe debug-env për të parë env në prod, vetëm me admin key)
app.get("/admin/debug-env", requireAdminKey, (req, res) => {
  const safe = (x) => (x ? String(x).slice(0, 4) + "***" : "");
  return res.json({
    success: true,
    version: APP_VERSION,
    node_env: process.env.NODE_ENV || "",
    has_db_url: !!process.env.DATABASE_URL,
    has_admin_key: !!process.env.ADMIN_KEY,
    has_make_webhook: !!process.env.MAKE_ALERTS_WEBHOOK_URL,
    public_base_url: process.env.PUBLIC_BASE_URL || "",
    api_key_masked: safe(process.env.API_KEY),
    restaurant_id_env: process.env.RESTAURANT_ID || "",
  });
});

app.get("/admin/restaurants", requireAdminKey, requireDbReady, async (req, res) => {
  const q = await pool.query(
    `SELECT id, name, owner_phone, plan, feedback_enabled, feedback_cooldown_days, feedback_batch_limit, feedback_exclude_frequent_over_visits, created_at
     FROM public.restaurants ORDER BY id ASC;`
  );
  res.json({ success: true, version: APP_VERSION, count: q.rows.length, data: q.rows });
});

app.post("/admin/restaurants", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const owner_phone = String(req.body?.owner_phone || "").trim(); // opsionale
    if (!name) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: name" });
    }

    const r = await pool.query(
      `INSERT INTO public.restaurants (name, owner_phone) VALUES ($1, $2) RETURNING id, name, owner_phone, plan, created_at;`,
      [name, owner_phone || ""]
    );
    const restaurant = r.rows[0];

    const api_key = genApiKey();
    const owner_key = genOwnerKey();

    const api_hash = hashKey(api_key);
    const owner_hash = hashKey(owner_key);

    await pool.query(
      `INSERT INTO public.api_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [restaurant.id, api_hash, "auto-created"]
    );
    await pool.query(
      `INSERT INTO public.owner_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [restaurant.id, owner_hash, "auto-created"]
    );

    return res.json({
      success: true,
      version: APP_VERSION,
      data: {
        restaurant,
        api_key,
        owner_key,
        note: "Ruaji këto keys tani. Në DB ruhet vetëm hash; s’mund t’i shohësh raw më vonë.",
      },
    });
  } catch (err) {
    console.error("❌ POST /admin/restaurants error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/admin/restaurants/:id/plan", requireAdminKey, requireDbReady, async (req, res) => {
  const id = Number(req.params.id);
  const plan = String(req.body?.plan || "").trim().toUpperCase();

  if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
  if (!["FREE", "PRO"].includes(plan)) {
    return res.status(400).json({ success: false, version: APP_VERSION, error: "plan must be FREE or PRO" });
  }

  const q = await pool.query(`UPDATE public.restaurants SET plan=$1 WHERE id=$2 RETURNING id,name,owner_phone,plan;`, [
    plan,
    id,
  ]);
  if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });

  res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
});
// =====================
// CRON: AUTO CLOSE RESERVATIONS
// =====================
app.post("/cron/auto-close", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const today = await getTodayAL();
    const nowHHMI = await getNowHHMI_AL();

    const bufferMinutes = 120;
    const cutoffHHMI = subtractMinutesHHMI(nowHHMI, bufferMinutes);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, reservation_id, status, date, time, phone, customer_name
      FROM public.reservations
      WHERE
        status IN ('Confirmed','Pending')
        AND (
          (date::date < $1::date)
          OR (
            date::date = $1::date
            AND NULLIF(time::text,'')::time <= $2::time
          )
        )
      ORDER BY date ASC, time ASC
      LIMIT 500;
      `,
      [today, cutoffHHMI]
    );

    let completed = 0;
    let noshow = 0;

    for (const r of q.rows) {
      const finalStatus = r.status === "Confirmed" ? "Completed" : "NoShow";

      const up = await pool.query(
        `
        UPDATE public.reservations
        SET status=$3, closed_at=NOW(), closed_reason='auto_close_cron'
        WHERE id=$1 AND restaurant_id=$2 AND status=$4
        RETURNING id;
        `,
        [r.id, r.restaurant_id, finalStatus, r.status]
      );

      if (up.rows.length) {
        if (finalStatus === "Completed") completed++;
        else noshow++;

        pool.query(
          `UPDATE public.events SET status=$3 WHERE restaurant_id=$1 AND reservation_id=$2;`,
          [r.restaurant_id, r.reservation_id, finalStatus]
        ).catch(() => {});
      }
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Auto-close done",
      data: { scanned: q.rows.length, completed, noshow, today, nowHHMI, cutoffHHMI }
    });
  } catch (e) {
    console.error("❌ /cron/auto-close error:", e);
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Auto-close failed"
    });
  }
}); // ✅ KJO MUNGONTE


// ✅ Admin: update feedback settings
app.post("/admin/restaurants/:id/feedback-settings", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const enabled =
      req.body?.feedback_enabled === undefined ? null : String(req.body.feedback_enabled).trim().toLowerCase();
    const feedback_enabled =
      enabled === null
        ? null
        : ["true", "1", "yes", "po", "ok"].includes(enabled)
        ? true
        : ["false", "0", "no", "jo"].includes(enabled)
        ? false
        : null;

    const feedback_cooldown_days =
      req.body?.feedback_cooldown_days === undefined ? null : Number(req.body.feedback_cooldown_days);
    const feedback_batch_limit = req.body?.feedback_batch_limit === undefined ? null : Number(req.body.feedback_batch_limit);
    const feedback_exclude_frequent_over_visits =
      req.body?.feedback_exclude_frequent_over_visits === undefined
        ? null
        : Number(req.body.feedback_exclude_frequent_over_visits);

    const feedback_template = req.body?.feedback_template === undefined ? null : String(req.body.feedback_template || "");

    const q = await pool.query(
      `
      UPDATE public.restaurants
      SET
        feedback_enabled = COALESCE($1, feedback_enabled),
        feedback_cooldown_days = COALESCE($2, feedback_cooldown_days),
        feedback_batch_limit = COALESCE($3, feedback_batch_limit),
        feedback_exclude_frequent_over_visits = COALESCE($4, feedback_exclude_frequent_over_visits),
        feedback_template = COALESCE($5, feedback_template)
      WHERE id=$6
      RETURNING id, name, feedback_enabled, feedback_cooldown_days, feedback_batch_limit, feedback_exclude_frequent_over_visits, feedback_template;
      `,
      [feedback_enabled, feedback_cooldown_days, feedback_batch_limit, feedback_exclude_frequent_over_visits, feedback_template, id]
    );

    if (!q.rows.length) return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });
    return res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /admin/restaurants/:id/feedback-settings error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/admin/keys/disable", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const type = String(req.body?.type || "").trim().toLowerCase(); // api | owner
    const rawKey = String(req.body?.key || "").trim();
    if (!["api", "owner"].includes(type)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "type must be api or owner" });
    }
    if (!rawKey) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing key" });
    }

    const keyHash = hashKey(rawKey);
    const table = type === "api" ? "public.api_keys" : "public.owner_keys";

    const q = await pool.query(
      `UPDATE ${table} SET is_active=FALSE WHERE key_hash=$1 RETURNING id, restaurant_id, label, is_active;`,
      [keyHash]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Key not found" });
    }

    res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /admin/keys/disable error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/admin/restaurants/:id/rotate-keys", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    await pool.query(`UPDATE public.api_keys SET is_active=FALSE WHERE restaurant_id=$1;`, [id]);
    await pool.query(`UPDATE public.owner_keys SET is_active=FALSE WHERE restaurant_id=$1;`, [id]);

    const api_key = genApiKey();
    const owner_key = genOwnerKey();

    const api_hash = hashKey(api_key);
    const owner_hash = hashKey(owner_key);

    await pool.query(
      `INSERT INTO public.api_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [id, api_hash, "rotated"]
    );
    await pool.query(
      `INSERT INTO public.owner_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [id, owner_hash, "rotated"]
    );

    res.json({
      success: true,
      version: APP_VERSION,
      data: {
        restaurant_id: id,
        api_key,
        owner_key,
        note: "Ruaji këto keys tani. Në DB ruhet vetëm hash; s’mund t’i shohësh raw më vonë.",
      },
    });
  } catch (err) {
    console.error("❌ POST /admin/restaurants/:id/rotate-keys error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== RATINGS HELPERS ====================
function toInt1to5(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 1 || i > 5) return null;
  return i;
}

function normalizeFeedbackRatings(body) {
  let loc = body.location_rating;
  let hos = body.hospitality_rating;
  let food = body.food_rating;
  let price = body.price_rating;

  if (
    (loc === undefined || hos === undefined || food === undefined || price === undefined) &&
    body.ratings &&
    typeof body.ratings === "object"
  ) {
    loc = loc ?? body.ratings.location;
    hos = hos ?? body.ratings.hospitality;
    food = food ?? body.ratings.food;
    price = price ?? body.ratings.price;
  }

  const single = body.rating ?? body.ratings;
  if (
    (loc === undefined || hos === undefined || food === undefined || price === undefined) &&
    (typeof single === "number" || typeof single === "string")
  ) {
    loc = loc ?? single;
    hos = hos ?? single;
    food = food ?? single;
    price = price ?? single;
  }

  return {
    location_rating: toInt1to5(loc),
    hospitality_rating: toInt1to5(hos),
    food_rating: toInt1to5(food),
    price_rating: toInt1to5(price),
  };
}

// ==================== CONSENTS (LEGAL) ====================
function toBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "po", "ok"].includes(s)) return true;
  if (["false", "0", "no", "jo"].includes(s)) return false;
  return null;
}

app.post("/consents", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const phone = String(b.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });
    }

    const full_name = b.full_name !== undefined ? String(b.full_name || "").trim() : null;

    const c_marketing = toBoolOrNull(b.consent_marketing ?? b.marketing);
    const c_sms = toBoolOrNull(b.consent_sms ?? b.sms);
    const c_whatsapp = toBoolOrNull(b.consent_whatsapp ?? b.whatsapp);
    const c_email = toBoolOrNull(b.consent_email ?? b.email);

    const anyProvided = [c_marketing, c_sms, c_whatsapp, c_email].some((x) => x !== null);
    if (!anyProvided && full_name === null) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: "No consent fields provided (send whatsapp/sms/email/marketing OR consent_* OR full_name).",
      });
    }

    const consent_source = b.consent_source ? String(b.consent_source).trim() : "manual";

    const q = await pool.query(
      `
      INSERT INTO public.customers (
        restaurant_id,
        phone,
        full_name,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        consent_source,
        consent_updated_at
      )
      VALUES (
        $1::bigint,
        $2::text,
        NULLIF($3::text,''),
        COALESCE($4::boolean, FALSE),
        COALESCE($5::boolean, FALSE),
        COALESCE($6::boolean, FALSE),
        COALESCE($7::boolean, FALSE),
        $8::text,
        NOW()
      )
      ON CONFLICT (restaurant_id, phone)
      DO UPDATE SET
        full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.customers.full_name),
        consent_marketing = COALESCE($4::boolean, public.customers.consent_marketing),
        consent_sms = COALESCE($5::boolean, public.customers.consent_sms),
        consent_whatsapp = COALESCE($6::boolean, public.customers.consent_whatsapp),
        consent_email = COALESCE($7::boolean, public.customers.consent_email),
        consent_source = $8::text,
        consent_updated_at = NOW(),
        updated_at = NOW()
      RETURNING
        id, restaurant_id, phone, full_name,
        consent_marketing, consent_sms, consent_whatsapp, consent_email,
        consent_source, consent_updated_at,
        created_at, updated_at;
      `,
      [req.restaurant_id, phone, full_name, c_marketing, c_sms, c_whatsapp, c_email, consent_source]
    );

    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /consents error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== SEGMENTS + AUDIENCE (PRO) ====================
function segmentFromDays(daysSince) {
  if (daysSince === null || daysSince === undefined) return "UNKNOWN";
  const n = Number(daysSince);
  if (!Number.isFinite(n)) return "UNKNOWN";
  if (n <= 14) return "ACTIVE";
  if (n <= 30) return "WARM";
  return "COLD";
}

app.get("/segments", requireApiKey, requireDbReady, requirePlan("PRO"), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 60), 1), 3650);
    const today = await getTodayAL();

    const q = await pool.query(
      `
      SELECT
        id,
        phone,
        full_name,
        visits_count,
        last_seen_at,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        ( ($1::date) - ((last_seen_at AT TIME ZONE 'Europe/Tirane')::date) )::int AS days_since_last
      FROM public.customers
      WHERE restaurant_id = $2
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
        AND last_seen_at <= NOW()
        AND (last_seen_at AT TIME ZONE 'Europe/Tirane')::date >= ($1::date - ($3::int || ' days')::interval)::date
      ORDER BY last_seen_at DESC;
      `,
      [today, req.restaurant_id, days]
    );

    const rows = q.rows.map((r) => ({
      id: String(r.id),
      phone: r.phone,
      full_name: r.full_name || "",
      visits_count: Number(r.visits_count || 0),
      last_seen_at: r.last_seen_at,
      last_seen_at_local: formatALDate(r.last_seen_at),
      consent_marketing: !!r.consent_marketing,
      consent_sms: !!r.consent_sms,
      consent_whatsapp: !!r.consent_whatsapp,
      consent_email: !!r.consent_email,
      days_since_last: Number.isFinite(Number(r.days_since_last)) ? Number(r.days_since_last) : null,
      segment: segmentFromDays(r.days_since_last),
    }));

    const vip = rows.filter((r) => r.visits_count >= 3);
    const active = rows.filter((r) => r.segment === "ACTIVE");
    const warm = rows.filter((r) => r.segment === "WARM");
    const cold = rows.filter((r) => r.segment === "COLD");
    const unknown = rows.filter((r) => r.segment === "UNKNOWN");

    const counts = {
      total: rows.length,
      vip: vip.length,
      active: active.length,
      warm: warm.length,
      cold: cold.length,
      unknown: unknown.length,
      whatsapp_true: rows.filter((r) => r.consent_whatsapp).length,
      marketing_true: rows.filter((r) => r.consent_marketing).length,
      sms_true: rows.filter((r) => r.consent_sms).length,
      email_true: rows.filter((r) => r.consent_email).length,
    };

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      params: { days },
      counts,
      data: { vip, active, warm, cold, unknown },
    });
  } catch (err) {
    console.error("❌ GET /segments error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.get("/audience/export", requireApiKey, requireDbReady, requirePlan("PRO"), async (req, res) => {
  try {
    const channel = String(req.query.channel || "whatsapp").trim().toLowerCase();
    const segment = String(req.query.segment || "all").trim().toLowerCase();
    const format = String(req.query.format || "json").trim().toLowerCase();
    const days = Math.min(Math.max(Number(req.query.days || 60), 1), 3650);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 2000);

    const consentColumn =
      channel === "sms"
        ? "consent_sms"
        : channel === "email"
        ? "consent_email"
        : channel === "marketing"
        ? "consent_marketing"
        : "consent_whatsapp";

    const today = await getTodayAL();

    const q = await pool.query(
      `
      SELECT
        phone,
        full_name,
        visits_count,
        last_seen_at,
        ( ($1::date) - ((last_seen_at AT TIME ZONE 'Europe/Tirane')::date) )::int AS days_since_last_visit
      FROM public.customers
      WHERE restaurant_id = $2
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
        AND last_seen_at <= NOW()
        AND (last_seen_at AT TIME ZONE 'Europe/Tirane')::date >= ($1::date - ($4::int || ' days')::interval)::date
        AND ${consentColumn} = TRUE
      ORDER BY last_seen_at DESC
      LIMIT $3;
      `,
      [today, req.restaurant_id, limit, days]
    );

    let rows = q.rows.map((r) => ({
      phone: r.phone,
      full_name: r.full_name || "",
      visits_count: Number(r.visits_count || 0),
      segment: segmentFromDays(r.days_since_last_visit),
      days_since_last_visit: Number.isFinite(Number(r.days_since_last_visit)) ? Number(r.days_since_last_visit) : null,
      last_seen_at: r.last_seen_at,
      last_seen_at_local: formatALDate(r.last_seen_at),
    }));

    if (segment !== "all") {
      const want = segment.toUpperCase();
      rows = rows.filter((r) => r.segment === want);
    }

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      const header = ["phone", "full_name", "segment", "visits_count", "days_since_last_visit", "last_seen_at_local"].join(
        ","
      );
      const body = rows
        .map((r) =>
          [
            r.phone,
            `"${String(r.full_name || "").replaceAll('"', '""')}"`,
            r.segment,
            r.visits_count,
            r.days_since_last_visit ?? "",
            `"${String(r.last_seen_at_local || "").replaceAll('"', '""')}"`,
          ].join(",")
        )
        .join("\n");
      return res.status(200).send(header + "\n" + body);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      filter: { channel, segment, days, limit, format: "json" },
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /audience/export error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});
function mapFinalStatus(action) {
  if (action === "complete") return "Completed";
  if (action === "no-show") return "NoShow";
  if (action === "cancel") return "Cancelled";
  return null;
}

async function closeReservationByOwner({ restaurant_id, reservationPkId, action }) {
  const finalStatus = mapFinalStatus(action);
  if (!finalStatus) return { ok: false, code: 400, error: "Invalid action" };

  const beforeQ = await pool.query(
    `
    SELECT id, reservation_id, status, date, time, phone, customer_name, restaurant_name, people, channel, area, created_at
    FROM public.reservations
    WHERE id=$1 AND restaurant_id=$2
    LIMIT 1;
    `,
    [reservationPkId, restaurant_id]
  );
  if (!beforeQ.rows.length) return { ok: false, code: 404, error: "Reservation not found" };

  const r = beforeQ.rows[0];
  const statusBefore = String(r.status || "");

  const finals = new Set(["Completed", "NoShow", "Cancelled"]);
  if (finals.has(statusBefore)) {
    return { ok: false, code: 409, error: `Already closed (${statusBefore})`, data: r };
  }

  if (action === "complete" && statusBefore !== "Confirmed") {
    return { ok: false, code: 409, error: "Can complete only Confirmed reservations", data: r };
  }
  if (action === "cancel" && !(statusBefore === "Pending" || statusBefore === "Confirmed")) {
    return { ok: false, code: 409, error: "Can cancel only Pending/Confirmed reservations", data: r };
  }
  if (action === "no-show" && !(statusBefore === "Pending" || statusBefore === "Confirmed")) {
    return { ok: false, code: 409, error: "Can mark no-show only Pending/Confirmed reservations", data: r };
  }

  // Atomic update with optimistic lock on previous status
  const up = await pool.query(
    `
    UPDATE public.reservations
    SET status=$3, closed_at=NOW(), closed_reason=$4
    WHERE id=$1 AND restaurant_id=$2 AND status=$5
    RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at, closed_at, closed_reason;
    `,
    [reservationPkId, restaurant_id, finalStatus, `owner_${action}`, statusBefore]
  );

  if (!up.rows.length) return { ok: false, code: 409, error: "State changed, try again" };

  const row = up.rows[0];

  // Sync events (best-effort)
  pool
    .query(`UPDATE public.events SET status=$3 WHERE restaurant_id=$1 AND reservation_id=$2;`, [
      restaurant_id,
      row.reservation_id,
      finalStatus,
    ])
    .catch(() => {});

  // Update customer stats ONLY on Completed (best-effort)
  if (finalStatus === "Completed") {
    const ymd = String(row.date).slice(0, 10);
    const hhmi = String(row.time || "").trim().slice(0, 5); // "HH:MI"

    pool
      .query(
        `
        INSERT INTO public.customers (restaurant_id, phone, full_name, first_seen_at, last_seen_at, visits_count)
        VALUES (
          $1,
          $2,
          $3,
          ((($4::date + $5::time) AT TIME ZONE 'Europe/Tirane')),
          ((($4::date + $5::time) AT TIME ZONE 'Europe/Tirane')),
          1
        )
        ON CONFLICT (restaurant_id, phone) DO UPDATE
        SET
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.customers.full_name),
          last_seen_at = GREATEST(public.customers.last_seen_at, EXCLUDED.last_seen_at),
          visits_count = public.customers.visits_count + 1,
          updated_at = NOW();
        `,
        [restaurant_id, row.phone, row.customer_name, ymd, hhmi]
      )
      .catch(() => {});
  }

  return { ok: true, status_before: statusBefore, status_after: finalStatus, row };
}

// ==================== OWNER VIEW (READ ONLY) ====================
app.get("/owner/customers", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const result = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        phone,
        full_name,
        visits_count,
        first_seen_at,
        last_seen_at,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        feedback_last_sent_at,
        feedback_last_received_at,
        created_at,
        updated_at
      FROM public.customers
      WHERE restaurant_id = $1
        AND (last_seen_at IS NULL OR last_seen_at <= NOW())
      ORDER BY last_seen_at DESC NULLS LAST, visits_count DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ GET /owner/customers error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.get("/owner/reservations", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const result = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        reservation_id,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        allergies,
        special_requests,
        status,
        feedback_requested_at,
        feedback_received_at,
        created_at
      FROM public.reservations
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /owner/reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});
app.post("/owner/reservations/:id/complete", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "complete",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_completed", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation completed.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ complete error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Complete failed" });
  }
});

app.post("/owner/reservations/:id/no-show", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "no-show",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_no_show", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation marked as no-show.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ no-show error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "No-show failed" });
  }
});

app.post("/owner/reservations/:id/cancel", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "cancel",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_cancelled", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation cancelled.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ cancel error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Cancel failed" });
  }
});

// ==================== OWNER FEEDBACK (OWNER-CONTROLLED) ====================
async function getFeedbackSettings(restaurantId) {
  const st = await pool.query(
    `
    SELECT
      feedback_enabled,
      feedback_cooldown_days,
      feedback_batch_limit,
      feedback_exclude_frequent_over_visits,
      feedback_template
    FROM public.restaurants
    WHERE id=$1
    LIMIT 1;
    `,
    [restaurantId]
  );
  return st.rows[0] || {
    feedback_enabled: true,
    feedback_cooldown_days: 10,
    feedback_batch_limit: 30,
    feedback_exclude_frequent_over_visits: 5,
    feedback_template: "",
  };
}

// Owner: send feedback to ONE customer (manual)
app.post("/owner/feedback/send-one", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const s = await getFeedbackSettings(req.restaurant_id);
    if (!s.feedback_enabled) {
      return res.status(403).json({ success: false, version: APP_VERSION, error: "Feedback disabled by owner" });
    }

    const cu = await pool.query(
      `
      SELECT id, phone, full_name, consent_whatsapp, visits_count, feedback_last_sent_at
      FROM public.customers
      WHERE restaurant_id=$1 AND phone=$2
      LIMIT 1;
      `,
      [req.restaurant_id, phone]
    );
    if (!cu.rows.length) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Customer not found" });
    }

    const c = cu.rows[0];
    if (!c.consent_whatsapp) {
      return res.status(409).json({ success: false, version: APP_VERSION, error: "Customer has no WhatsApp consent" });
    }

    const cooldownDays = Number(s.feedback_cooldown_days || 10);
    const okCooldown =
      !c.feedback_last_sent_at || new Date(c.feedback_last_sent_at).getTime() < Date.now() - cooldownDays * 86400000;
    if (!okCooldown) {
      return res
        .status(409)
        .json({ success: false, version: APP_VERSION, error: "Cooldown active (already contacted recently)" });
    }

    // Mark sent first (anti-spam)
    await pool.query(
      `
      UPDATE public.customers
      SET feedback_last_sent_at = NOW(), updated_at = NOW()
      WHERE id=$1 AND restaurant_id=$2;
      `,
      [c.id, req.restaurant_id]
    );

    fireFeedbackRequest({
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: {
        customer_id: c.id,
        phone: c.phone,
        full_name: c.full_name || "",
        template: s.feedback_template || "",
        mode: "manual_one",
      },
    });

    return res.json({ success: true, version: APP_VERSION, sent: true, phone: c.phone, customer_id: c.id });
  } catch (err) {
    console.error("❌ POST /owner/feedback/send-one error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// Owner: send feedback to BATCH (yesterday by default)
app.post("/owner/feedback/send-batch", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const date_from_in = String(req.body?.date_from || "").trim(); // "YYYY-MM-DD"
    const date_to_in = String(req.body?.date_to || "").trim(); // "YYYY-MM-DD"
    const limitReq = Number(req.body?.limit || 0);

    const s = await getFeedbackSettings(req.restaurant_id);
    if (!s.feedback_enabled) {
      return res.status(403).json({ success: false, version: APP_VERSION, error: "Feedback disabled by owner" });
    }

    const cooldownDays = Number(s.feedback_cooldown_days || 10);
    const excludeOver = Number(s.feedback_exclude_frequent_over_visits || 5);
    const batchLimit = Math.min(Math.max(limitReq || Number(s.feedback_batch_limit || 30), 1), 200);

    // Default: dje
    let from = date_from_in;
    let to = date_to_in;
    if (!from || !to) {
      const today = await getTodayAL();
      const y = (await pool.query(`SELECT ($1::date - INTERVAL '1 day')::date::text AS d;`, [today])).rows[0].d;
      from = y;
      to = y;
    }

    const q = await pool.query(
      `
      WITH candidates AS (
        SELECT DISTINCT
          cu.id AS customer_id,
          cu.phone,
          cu.full_name,
          cu.visits_count,
          cu.feedback_last_sent_at
        FROM public.reservations r
        JOIN public.customers cu
          ON cu.restaurant_id = r.restaurant_id
         AND cu.phone = r.phone
        WHERE r.restaurant_id = $1
          AND r.date::date BETWEEN $2::date AND $3::date
          AND cu.consent_whatsapp = TRUE
          AND (cu.feedback_last_sent_at IS NULL OR cu.feedback_last_sent_at < NOW() - ($4::int || ' days')::interval)
          AND (cu.visits_count IS NULL OR cu.visits_count <= $5::int)
      )
      SELECT * FROM candidates
      ORDER BY visits_count ASC NULLS FIRST
      LIMIT $6;
      `,
      [req.restaurant_id, from, to, cooldownDays, excludeOver, batchLimit]
    );

    const rows = q.rows;

    const ids = rows.map((x) => x.customer_id);
    if (ids.length) {
      await pool.query(
        `
        UPDATE public.customers
        SET feedback_last_sent_at = NOW(), updated_at = NOW()
        WHERE restaurant_id=$1 AND id = ANY($2::bigint[]);
        `,
        [req.restaurant_id, ids]
      );
    }

    for (const c of rows) {
      fireFeedbackRequest({
        restaurant_id: req.restaurant_id,
        ts: new Date().toISOString(),
        data: {
          customer_id: c.customer_id,
          phone: c.phone,
          full_name: c.full_name || "",
          template: s.feedback_template || "",
          mode: "manual_batch",
          date_from: from,
          date_to: to,
        },
      });
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      range: { from, to },
      sent_count: rows.length,
      sent: rows.map((x) => ({ customer_id: x.customer_id, phone: x.phone, full_name: x.full_name || "" })),
    });
  } catch (err) {
    console.error("❌ POST /owner/feedback/send-batch error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== EVENTS (CORE) ====================
app.post("/events", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["event_date", "event_time"];
    for (const f of required) {
      if (!b[f]) {
        return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${f}` });
      }
    }

    const people = b.people === undefined || b.people === null || b.people === "" ? null : Number(b.people);
    if (people !== null && (!Number.isFinite(people) || people <= 0)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be positive number" });
    }

    const status = b.status || "Pending";

    const result = await pool.query(
      `
      INSERT INTO public.events
      (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
      VALUES
      ($1,$2,$3,$4,$5::date,$6::time,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, created_at;
      `,
      [
        req.restaurant_id,
        b.customer_id || null,
        b.reservation_id || null,
        b.event_type || "restaurant_reservation",
        String(b.event_date).trim(),
        normalizeTimeHHMI(b.event_time),
        people,
        status,
        b.source || b.channel || null,
        b.area || null,
        b.allergies ?? "",
        b.special_requests ?? "",
        b.notes ?? "",
        b.created_by || "AI",
      ]
    );

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: { id: row.id, created_at: row.created_at, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

app.get("/events", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, customer_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== RESERVATIONS ====================
app.post("/reservations", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const r = req.body || {};
    const required = ["customer_name", "phone", "date", "time", "people"];
    for (const f of required) {
      if (r[f] === undefined || r[f] === null || r[f] === "") {
        return res.status(400).json({
          success: false,
          version: APP_VERSION,
          error: `Missing field: ${f}`,
          error_code: "MISSING_FIELD",
        });
      }
    }

    const people = Number(r.people);
    if (!Number.isFinite(people) || people <= 0) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: "people must be a positive number",
        error_code: "INVALID_PEOPLE",
      });
    }

    const dateStr = String(r.date).trim();

    // strict normalize HH:MI
    const timeStr = normalizeTimeHHMI(r.time);
    if (!timeStr) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: "Ora është e pavlefshme.",
        error_code: "INVALID_TIME",
      });
    }

    // reject if today and time passed
    const guard = await rejectIfTimePassedTodayAL(dateStr, timeStr);
    if (!guard.ok) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error_code: guard.error_code || "TIME_PASSED",
        error:
          guard.message ||
          "Ora që ke zgjedhur ka kaluar.\nTë lutem zgjidh një orë tjetër sot ose një ditë tjetër.",
      });
    }

    const decision = await decideReservationStatus(req.restaurant_id, dateStr, people);
    const status = decision.status;

    const reservation_id = r.reservation_id || crypto.randomUUID();

    const result = await pool.query(
      `
      INSERT INTO public.reservations (
        restaurant_id,
        reservation_id,
        restaurant_name,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        first_time,
        allergies,
        special_requests,
        raw,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, reservation_id, created_at, status;
      `,
      [
        req.restaurant_id,
        reservation_id,
        r.restaurant_name || "Te Ta Gastronomi",
        r.customer_name,
        r.phone,
        dateStr,
        timeStr,
        people,
        r.channel || null,
        r.area || null,
        r.first_time || null,
        r.allergies || "",
        r.special_requests || "",
        r,
        status,
      ]
    );

    const inserted = result.rows[0];

    const payload = {
      restaurant_id: req.restaurant_id,
      restaurant_name: r.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: inserted.id,
        reservation_id: inserted.reservation_id,
        date: dateStr,
        time: timeStr,
        people,
        customer_name: r.customer_name,
        phone: r.phone,
        channel: r.channel || null,
        area: r.area || null,
        status: inserted.status,
        reason: decision.reason || null,
      },
    };

    // CLICK LINKS only for Pending
    if (status === "Pending") {
      const base = String(process.env.PUBLIC_BASE_URL || "https://teta-ai-backend-production.up.railway.app").replace(/\/$/, "");

      const confirmToken = crypto.randomBytes(18).toString("hex");
      const declineToken = crypto.randomBytes(18).toString("hex");

      await pool.query(
        `
        INSERT INTO public.owner_action_tokens (restaurant_id, reservation_id, token, action, expires_at)
        VALUES
          ($1,$2,$3,'confirm', NOW() + INTERVAL '2 hours'),
          ($1,$2,$4,'decline', NOW() + INTERVAL '2 hours');
        `,
        [req.restaurant_id, inserted.id, confirmToken, declineToken]
      );

      payload.data.confirm_url = `${base}/o/confirm/${confirmToken}`;
      payload.data.decline_url = `${base}/o/decline/${declineToken}`;
    }

    // Make events
    if (inserted.status === "Pending") fireMakeEvent("reservation_created", payload);
    else fireMakeEvent("reservation_confirmed", payload);

    // Sync to customers (non-blocking)
    try {
      await pool.query(
        `
        WITH flags AS (
          SELECT
            NOW() AS now_ts,
            (($1::date + $2::time) AT TIME ZONE 'Europe/Tirane') AS ts,
            CASE WHEN (($1::date + $2::time) AT TIME ZONE 'Europe/Tirane') <= NOW() THEN 1 ELSE 0 END AS is_past
        )
        INSERT INTO public.customers (
          restaurant_id, phone, full_name,
          first_seen_at, last_seen_at, visits_count,
          created_at, updated_at
        )
        VALUES (
          $3, $4, NULLIF($5,''),
          (SELECT now_ts FROM flags),
          (SELECT CASE WHEN is_past=1 THEN ts ELSE NULL END FROM flags),
          (SELECT CASE WHEN is_past=1 THEN 1 ELSE 0 END FROM flags),
          NOW(), NOW()
        )
        ON CONFLICT (restaurant_id, phone)
        DO UPDATE SET
          full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.customers.full_name),
          first_seen_at = COALESCE(public.customers.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = CASE
            WHEN (SELECT is_past FROM flags)=1
            THEN GREATEST(COALESCE(public.customers.last_seen_at, (SELECT ts FROM flags)), (SELECT ts FROM flags))
            ELSE public.customers.last_seen_at
          END,
          visits_count = public.customers.visits_count + (SELECT CASE WHEN is_past=1 THEN 1 ELSE 0 END FROM flags),
          updated_at = NOW();
        `,
        [dateStr, timeStr, req.restaurant_id, r.phone, r.customer_name]
      );
    } catch (e) {
      console.error("⚠️ Sync to customers failed (non-blocking):", e.message);
    }

    // Sync to events (non-blocking)
    try {
      await pool.query(
        `
        INSERT INTO public.events
        (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
        VALUES
        ($1,$2,$3,'restaurant_reservation',$4::date,$5::time,$6,$7,$8,$9,$10,$11,$12,$13);
        `,
        [
          req.restaurant_id,
          null,
          reservation_id,
          dateStr,
          timeStr,
          people,
          status,
          r.channel || null,
          r.area || null,
          r.allergies || "",
          r.special_requests || "",
          "Synced from /reservations",
          "AI",
        ]
      );
    } catch (e) {
      console.error("⚠️ Sync to events failed (non-blocking):", e.message);
    }

    const httpStatus = status === "Pending" ? 202 : 201;

    return res.status(httpStatus).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: status === "Pending" ? "Reservation pending owner approval." : "Reservation confirmed.",
      data: { ...inserted, created_at_local: formatALDate(inserted.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations error:", err);
    if (err && err.code === "23505") {
      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: "Duplicate reservation",
        detail: err.detail || null,
        code: err.code,
      });
    }
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

app.get("/reservations", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests,
        status, feedback_requested_at, feedback_received_at, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.get("/reservations/upcoming", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = await getTodayAL();
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days])).rows[0].d;

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests,
        status, feedback_requested_at, feedback_received_at, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
        AND date::date >= $2::date
        AND date::date <= $3::date
      ORDER BY date ASC, time ASC, created_at ASC;
      `,
      [req.restaurant_id, today, end]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));

    return res.json({
      success: true,
      version: APP_VERSION,
      range: { from: today, to: end, days },
      restaurant_id: req.restaurant_id,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /reservations/upcoming error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});


// ==================== OWNER CONFIRM / DECLINE (ONLY PENDING) ====================

// Small audit logger (console -> Railway logs)
function logOwnerDecision(req, action, meta = {}) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || req.ip;

  console.log("OWNER_DECISION", {
    action, // "confirm" | "decline"
    actor: meta.actor || "owner_key", // owner_key | click_link
    token: meta.token || null,
    id: meta.id || null, // reservation numeric id (public.reservations.id)
    reservation_id: meta.reservation_id || null, // uuid/text if you use it
    restaurant_id: meta.restaurant_id || req.restaurant_id || null,
    status_before: meta.status_before || null,
    status_after: meta.status_after || null,
    ip,
    ua: req.headers["user-agent"] || null,
    referer: req.headers["referer"] || null,
    ts: new Date().toISOString(),
  });
}

app.post("/owner/reservations/:id/confirm", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    // Optional: check current status for better logs when update doesn't happen
    const before = await pool.query(
      `SELECT status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [id, req.restaurant_id]
    );
    const statusBefore = before.rows?.[0]?.status || null;
    const reservationUuid = before.rows?.[0]?.reservation_id || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Confirmed'
      WHERE id = $1
        AND restaurant_id = $2
        AND status = 'Pending'
      RETURNING
        id,
        reservation_id,
        restaurant_id,
        restaurant_name,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        status,
        created_at;
      `,
      [id, req.restaurant_id]
    );

    if (!up.rows.length) {
      if (!before.rows.length) {
        logOwnerDecision(req, "confirm", {
          actor: "owner_key",
          id,
          restaurant_id: req.restaurant_id,
          status_before: null,
          status_after: null,
        });
        return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
      }

      logOwnerDecision(req, "confirm", {
        actor: "owner_key",
        id,
        reservation_id: reservationUuid,
        restaurant_id: req.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });

      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: `Already decided: ${statusBefore}`,
      });
    }

    const row = up.rows[0];

    logOwnerDecision(req, "confirm", {
      actor: "owner_key",
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Confirmed",
    });

    pool
      .query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    const payload = {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    };

    fireMakeEvent("reservation_confirmed", payload);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /owner/reservations/:id/confirm error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Confirm failed" });
  }
});

app.post("/owner/reservations/:id/decline", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const before = await pool.query(
      `SELECT status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [id, req.restaurant_id]
    );
    const statusBefore = before.rows?.[0]?.status || null;
    const reservationUuid = before.rows?.[0]?.reservation_id || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Declined'
      WHERE id = $1
        AND restaurant_id = $2
        AND status = 'Pending'
      RETURNING
        id,
        reservation_id,
        restaurant_id,
        restaurant_name,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        status,
        created_at;
      `,
      [id, req.restaurant_id]
    );

    if (!up.rows.length) {
      if (!before.rows.length) {
        logOwnerDecision(req, "decline", {
          actor: "owner_key",
          id,
          restaurant_id: req.restaurant_id,
          status_before: null,
          status_after: null,
        });
        return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
      }

      logOwnerDecision(req, "decline", {
        actor: "owner_key",
        id,
        reservation_id: reservationUuid,
        restaurant_id: req.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });

      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: `Already decided: ${statusBefore}`,
      });
    }

    const row = up.rows[0];

    logOwnerDecision(req, "decline", {
      actor: "owner_key",
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Declined",
    });

    pool
      .query(`UPDATE public.events SET status='Declined' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    const payload = {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    };

    fireMakeEvent("reservation_declined", payload);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation declined.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /owner/reservations/:id/decline error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Decline failed" });
  }
});

// ==================== OWNER CLICK LINKS (PUBLIC) ====================
async function consumeOwnerToken(token, action) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, code: 400, error: "Missing token" };

  const q = await pool.query(
    `
    SELECT id, restaurant_id, reservation_id, action, expires_at, used_at
    FROM public.owner_action_tokens
    WHERE token=$1
    LIMIT 1;
    `,
    [t]
  );

  if (!q.rows.length) return { ok: false, code: 404, error: "Token not found" };

  const row = q.rows[0];
  if (row.action !== action) return { ok: false, code: 409, error: "Token action mismatch" };
  if (row.used_at) return { ok: false, code: 409, error: "Token already used" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, code: 410, error: "Token expired" };

  const u = await pool.query(
    `
    UPDATE public.owner_action_tokens
    SET used_at=NOW()
    WHERE token=$1 AND used_at IS NULL
    RETURNING token;
    `,
    [t]
  );
  if (!u.rows.length) return { ok: false, code: 409, error: "Token already used" };

  // reservation_id here is the numeric PK id (public.reservations.id)
  return { ok: true, restaurant_id: row.restaurant_id, reservation_pk_id: row.reservation_id };
}

function htmlPage(title, msg) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto">
<h2>${title}</h2>
<p>${msg}</p>
</body></html>`;
}

app.get("/o/confirm/:token", requireDbReady, async (req, res) => {
  try {
    const consumed = await consumeOwnerToken(req.params.token, "confirm");
    if (!consumed.ok) {
      logOwnerDecision(req, "confirm", {
        actor: "click_link",
        token: req.params.token,
        status_before: null,
        status_after: null,
      });
      return res.status(consumed.code).send(htmlPage("Error", consumed.error));
    }

    // Fetch current state for better logging
    const before = await pool.query(
      `SELECT id, status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );
    const id = before.rows?.[0]?.id || null;
    const statusBefore = before.rows?.[0]?.status || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status='Confirmed'
      WHERE id=$1 AND restaurant_id=$2 AND status='Pending'
      RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at;
      `,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );

    if (!up.rows.length) {
      logOwnerDecision(req, "confirm", {
        actor: "click_link",
        token: req.params.token,
        id,
        reservation_id: before.rows?.[0]?.reservation_id || null,
        restaurant_id: consumed.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });
      return res.status(409).send(htmlPage("Already decided", "Rezervimi nuk është më Pending."));
    }

    const row = up.rows[0];

    logOwnerDecision(req, "confirm", {
      actor: "click_link",
      token: req.params.token,
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Confirmed",
    });

    pool
      .query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        row.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    fireMakeEvent("reservation_confirmed", {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name,
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    });

    return res.status(200).send(htmlPage("✅ Confirmed", "Rezervimi u konfirmua me sukses."));
  } catch (e) {
    console.error("❌ GET /o/confirm/:token error:", e);
    logOwnerDecision(req, "confirm", { actor: "click_link", token: req.params.token, status_before: null, status_after: null });
    return res.status(500).send(htmlPage("Error", "Confirm failed"));
  }
});

app.get("/o/decline/:token", requireDbReady, async (req, res) => {
  try {
    const consumed = await consumeOwnerToken(req.params.token, "decline");
    if (!consumed.ok) {
      logOwnerDecision(req, "decline", {
        actor: "click_link",
        token: req.params.token,
        status_before: null,
        status_after: null,
      });
      return res.status(consumed.code).send(htmlPage("Error", consumed.error));
    }

    const before = await pool.query(
      `SELECT id, status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );
    const id = before.rows?.[0]?.id || null;
    const statusBefore = before.rows?.[0]?.status || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status='Declined'
      WHERE id=$1 AND restaurant_id=$2 AND status='Pending'
      RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at;
      `,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );

    if (!up.rows.length) {
      logOwnerDecision(req, "decline", {
        actor: "click_link",
        token: req.params.token,
        id,
        reservation_id: before.rows?.[0]?.reservation_id || null,
        restaurant_id: consumed.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });
      return res.status(409).send(htmlPage("Already decided", "Rezervimi nuk është më Pending."));
    }

    const row = up.rows[0];

    logOwnerDecision(req, "decline", {
      actor: "click_link",
      token: req.params.token,
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Declined",
    });

    pool
      .query(`UPDATE public.events SET status='Declined' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        row.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    fireMakeEvent("reservation_declined", {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name,
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    });

    return res.status(200).send(htmlPage("❌ Declined", "Rezervimi u refuzua."));
  } catch (e) {
    console.error("❌ GET /o/decline/:token error:", e);
    logOwnerDecision(req, "decline", { actor: "click_link", token: req.params.token, status_before: null, status_after: null });
    return res.status(500).send(htmlPage("Error", "Decline failed"));
  }
});
// ==================== DEBUG: SEND MAKE EVENT (OWNER ONLY) ====================
app.post("/owner/debug/make/:type", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const type = String(req.params.type || "").trim();
    if (!type) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing type" });

    const incoming = (req.body && typeof req.body === "object") ? req.body : {};

    const payload = {
      ...incoming,
      restaurant_id: req.restaurant_id,
      ts: incoming.ts || new Date().toISOString(),
    };

    fireMakeEvent(type, payload);

    return res.json({ success: true, version: APP_VERSION, sent_type: type, restaurant_id: req.restaurant_id });
  } catch (e) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: e.message });
  }
});

// ==================== FEEDBACK ====================
app.post("/feedback", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const phone = req.body?.phone;
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const ratings = normalizeFeedbackRatings(req.body);
    if (Object.values(ratings).some((v) => v === null)) {
      return res
        .status(400)
        .json({ success: false, version: APP_VERSION, error: "Ratings must be numbers between 1 and 5" });
    }

    const reservation_pk_id = req.body?.reservation_id ? Number(req.body.reservation_id) : null;
    const reservationIdSafe = Number.isFinite(reservation_pk_id) ? reservation_pk_id : null;

    const result = await pool.query(
      `
      INSERT INTO public.feedback
        (restaurant_id, restaurant_name, phone,
         location_rating, hospitality_rating, food_rating, price_rating, comment, reservation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, created_at;
      `,
      [
        req.restaurant_id,
        "Te Ta Gastronomi",
        String(phone).trim(),
        ratings.location_rating,
        ratings.hospitality_rating,
        ratings.food_rating,
        ratings.price_rating,
        req.body.comment || "",
        reservationIdSafe,
      ]
    );

    // Mark "received" timestamps (best-effort)
    pool
      .query(
        `UPDATE public.customers SET feedback_last_received_at=NOW(), updated_at=NOW()
         WHERE restaurant_id=$1 AND phone=$2;`,
        [req.restaurant_id, String(phone).trim()]
      )
      .catch(() => {});

    if (reservationIdSafe) {
      pool
        .query(
          `UPDATE public.reservations SET feedback_received_at=NOW()
           WHERE restaurant_id=$1 AND id=$2;`,
          [req.restaurant_id, reservationIdSafe]
        )
        .catch(() => {});
    }

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.get("/feedback", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const result = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        restaurant_name,
        phone,
        location_rating,
        hospitality_rating,
        food_rating,
        price_rating,
        ROUND((location_rating + hospitality_rating + food_rating + price_rating) / 4.0, 1) AS avg_rating,
        comment,
        reservation_id,
        created_at
      FROM public.feedback
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== REPORTS ====================
// ==================== REPORTS ====================
app.get("/reports/today", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const today = await getTodayAL();

    const reservations = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests, status,
        feedback_requested_at, feedback_received_at, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
        AND date::date = $2::date
      ORDER BY time ASC;
      `,
      [req.restaurant_id, today]
    );

    const reservationsRows = reservations.rows.map((x) => ({
      ...x,
      created_at_local: formatALDate(x.created_at),
    }));

    const feedback = await pool.query(
      `
      SELECT
        id, restaurant_id, restaurant_name, phone,
        location_rating, hospitality_rating, food_rating, price_rating,
        ROUND((location_rating + hospitality_rating + food_rating + price_rating) / 4.0, 1) AS avg_rating,
        comment, reservation_id, created_at
      FROM public.feedback
      WHERE restaurant_id = $1
        AND (created_at AT TIME ZONE 'Europe/Tirane')::date = $2::date
      ORDER BY created_at DESC;
      `,
      [req.restaurant_id, today]
    );

    const feedbackRows = feedback.rows.map((f) => ({
      ...f,
      created_at_local: formatALDate(f.created_at),
    }));

    const feedbackCount = feedbackRows.length;

    const avgOfAvg =
      feedbackCount === 0
        ? null
        : Math.round((feedbackRows.reduce((s, x) => s + Number(x.avg_rating || 0), 0) / feedbackCount) * 10) / 10;

    const fiveStars = feedbackCount === 0 ? 0 : feedbackRows.filter((x) => Number(x.avg_rating) >= 5).length;
    const fiveStarsPct = feedbackCount === 0 ? 0 : Math.round((fiveStars / feedbackCount) * 100);

    return res.json({
      success: true,
      version: APP_VERSION,
      date_local: today,
      restaurant_id: req.restaurant_id,
      summary: {
        reservations_today: reservationsRows.length,
        feedback_today: feedbackCount,
        avg_rating_today: avgOfAvg,
        five_star_feedback_today: fiveStars,
        five_star_pct_today: fiveStarsPct,
      },
      reservations: reservationsRows,
      feedback: feedbackRows,
    });
  } catch (err) {
    console.error("❌ GET /reports/today error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ===============================
// FEEDBACK: Save messages from Make / WhatsApp
// POST /feedback/messages
// ===============================
app.post("/feedback/messages", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const {
      twilio_message_sid = null,
      feedback_request_id = null,
      from_phone,
      message_body,
      direction = "inbound",
      classification = null,
      score = null,
    } = req.body || {};

    if (!from_phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "from_phone is required" });
    if (!message_body) return res.status(400).json({ success: false, version: APP_VERSION, error: "message_body is required" });

    const dir = String(direction || "").trim().toLowerCase();
    if (!["inbound", "outbound"].includes(dir)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "direction must be inbound|outbound" });
    }

    const parsedScore = score === null || score === undefined || score === "" ? null : Number(score);
    if (parsedScore !== null && (!Number.isInteger(parsedScore) || parsedScore < 1 || parsedScore > 10)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "score must be integer 1-10 (or null)" });
    }

    const q = `
      INSERT INTO public.feedback_messages
        (twilio_message_sid, feedback_request_id, restaurant_id, from_phone, message_body, direction, classification, score)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (twilio_message_sid) DO NOTHING
      RETURNING id, restaurant_id, from_phone, classification, score, created_at;
    `;

    const vals = [
      twilio_message_sid,
      feedback_request_id,
      req.restaurant_id,
      String(from_phone).trim(),
      String(message_body),
      dir,
      classification ? String(classification) : null,
      parsedScore,
    ];

    const result = await pool.query(q, vals);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: result.rows[0] || null,
      duplicate: result.rows.length === 0,
    });
  } catch (err) {
    console.error("❌ POST /feedback/messages error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Internal server error" });
  }
});

// ===============================
// OWNER: Daily feedback report
// GET /owner/reports/feedback/daily
// ===============================
app.get("/owner/reports/feedback/daily", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const q = `
      SELECT
        ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date)::text AS day,
        COUNT(*)::int AS total_feedback,
        ROUND(AVG(score)::numeric, 2) AS avg_score,
        SUM(CASE WHEN classification = 'risk' THEN 1 ELSE 0 END)::int AS risk_count,
        SUM(CASE WHEN classification = 'positive' THEN 1 ELSE 0 END)::int AS positive_count
      FROM public.feedback_messages
      WHERE direction='inbound'
        AND restaurant_id=$1
        AND (created_at AT TIME ZONE 'Europe/Tirane')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date;
    `;

    const r = await pool.query(q, [req.restaurant_id]);
    const row = r.rows[0] || null;
    const total = row ? Number(row.total_feedback || 0) : 0;

    if (!row || total === 0) {
      return res.json({
        success: true,
        version: APP_VERSION,
        restaurant_id: req.restaurant_id,
        message: "No feedback today",
        data: null,
      });
    }

    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: row });
  } catch (err) {
    console.error("❌ daily feedback report error", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "internal error" });
  }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));


// ==================== ERROR HANDLER (LAST) ====================
app.use((err, req, res, next) => {
  try {
    const isBadJson = err?.type === "entity.parse.failed";
    const msg = isBadJson ? "Invalid JSON body" : (err?.message || "Server error");
    const code = isBadJson ? 400 : 500;
    return res.status(code).json({ success: false, version: APP_VERSION, error: msg });
  } catch (_) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Server error" });
  }
});