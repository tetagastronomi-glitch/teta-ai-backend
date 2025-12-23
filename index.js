/**
 * index.js (FINAL - MULTI-RESTAURANT)
 * Te Ta AI Backend — Reservations + Feedback + Events(CORE) + Reports (Today + Dashboard)
 * + CRM Customers + Consents (LEGAL) + Owner View (read-only via OWNER_KEY)
 * + Segments (premium format) + Audience Export (with days filter)
 *
 * ✅ SaaS Mode:
 * - x-api-key validated from DB table public.api_keys (hashed)
 * - x-owner-key validated from DB table public.owner_keys (hashed)
 * - restaurant_id comes from key => req.restaurant_id
 */

require("dotenv").config({ override: true });
process.env.TZ = "Europe/Tirane";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const MAX_AUTO_CONFIRM_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 8);

// ✅ version marker (ndryshoje kur bën deploy)
const APP_VERSION = "v-2025-12-23-multirestaurant-auth-1";

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

// ==================== TIME HELPERS ====================
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

// Helper: get "today" in Albania date (server-agnostic)
async function getTodayAL() {
  const q = await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`);
  return q.rows[0].d;
}

// Helper normalize HH:MI (for casting to time safely)
function normalizeTimeHHMI(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "00:00";
  let hh = Number(m[1]);
  let mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return "00:00";
  if (hh < 0) hh = 0;
  if (hh > 23) hh = 23;
  if (mm < 0) mm = 0;
  if (mm > 59) mm = 59;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

// ==================== AUTH HELPERS (DB KEYS) ====================
function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

/**
 * ✅ requireApiKey
 * Reads x-api-key (raw), hashes it, validates against public.api_keys
 * Sets req.restaurant_id
 */
async function requireApiKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-api-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Missing x-api-key" });
    }

    const keyHash = hashKey(rawKey);

    const q = `
      SELECT restaurant_id
      FROM public.api_keys
      WHERE key_hash = $1 AND is_active = TRUE
      LIMIT 1;
    `;
    const r = await pool.query(q, [keyHash]);

    if (r.rows.length === 0) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Invalid api key" });
    }

    req.restaurant_id = Number(r.rows[0].restaurant_id);

    // best effort usage tracking (mos e blloko request)
    pool.query(`UPDATE public.api_keys SET last_used_at = NOW() WHERE key_hash = $1;`, [keyHash]).catch(() => {});

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Auth failed" });
  }
}

/**
 * ✅ requireOwnerKey
 * Reads x-owner-key (raw), hashes it, validates against public.owner_keys
 * Sets req.restaurant_id
 */
async function requireOwnerKey(req, res, next) {
  try {/**
 * 🔒 requireAdminKey
 * Master access (platform owner only)
 */
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
      return res.status(500).json({
        success: false,
        version: APP_VERSION,
        error: "ADMIN_KEY not configured",
      });
    }

    if (!safeEqual(rawKey, expected)) {
      return res.status(401).json({
        success: false,
        version: APP_VERSION,
        error: "Invalid admin key",
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Admin auth failed",
    });
  }
}

    const rawKey = String(req.headers["x-owner-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Missing x-owner-key" });
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
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Invalid owner key" });
    }

    req.restaurant_id = Number(r.rows[0].restaurant_id);

    pool.query(`UPDATE public.owner_keys SET last_used_at = NOW() WHERE key_hash = $1;`, [keyHash]).catch(() => {});

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Owner auth failed" });
  }
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

    // ✅ api_keys
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

    // ✅ owner_keys
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

    // Ensure columns exist (non-breaking). ⚠️ MOS prek date type (është DATE).
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

    // Owner views (read-only surface)
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

// ==================== HEALTH ====================
app.get("/", (req, res) => {
  res.status(200).send(`Te Ta Backend is running ✅ (${APP_VERSION})`);
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

// ==================== DEBUG ====================

// ==================== DEBUG (DEV ONLY) ====================
// ✅ Në production (Railway), debug endpoints nuk ekzistojnë (404).
function requireNotProduction(req, res, next) {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  if (env === "production") {
    return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });
  }
  next();
}

// Debug owner key exists (nuk e tregon sekretin)
app.get("/debug/owner-key", requireNotProduction, requireApiKey, (req, res) => {
  return res.json({
    success: true,
    version: APP_VERSION,
    has_owner_key: !!process.env.OWNER_KEY,
    owner_key_length: process.env.OWNER_KEY ? String(process.env.OWNER_KEY).length : 0,
  });
});

// Debug customers (vetëm me api-key)
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
    [req.restaurant_id] // ✅ nga auth middleware (multi-restaurant)
  );

  return res.json({
    success: true,
    version: APP_VERSION,
    restaurant_id: req.restaurant_id,
    count: q.rows.length,
    data: q.rows,
  });
});

// Debug compare owner auth (tregon pse s'po kalon 401 pa ekspozuar sekretin)
app.get("/debug/owner-auth", requireNotProduction, requireApiKey, (req, res) => {
  const provided = String(req.headers["x-owner-key"] ?? "").trim();
  const expected = String(process.env.OWNER_KEY ?? "").trim();
  return res.json({
    success: true,
    version: APP_VERSION,
    has_owner_key: !!process.env.OWNER_KEY,
    provided_present: provided.length > 0,
    provided_length: provided.length,
    expected_length: expected.length,
    match: provided.length > 0 && expected.length > 0 && safeEqual(provided, expected),
  });
});

// Debug reservations schema (vetëm me api-key)
app.get("/debug/reservations-schema", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
  const q = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reservations'
    ORDER BY ordinal_position;
  `);
  return res.json({ success: true, version: APP_VERSION, columns: q.rows });
});

// Debug reservations constraints (vetëm me api-key)
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

// Helper: normalize boolean values safely
function toBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "po", "ok"].includes(s)) return true;
  if (["false", "0", "no", "jo"].includes(s)) return false;
  return null;
}

/**
 * POST /consents
 * NOTE: Nëse një consent nuk vjen në body, nuk e ndryshojmë.
 * ✅ pranon edhe alias keys: whatsapp/sms/email/marketing
 */
app.post("/consents", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const phone = String(b.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });
    }

    const full_name = b.full_name !== undefined ? String(b.full_name || "").trim() : null;

    // ✅ ALIAS SUPPORT (final)
    const c_marketing = toBoolOrNull(b.consent_marketing ?? b.marketing);
    const c_sms = toBoolOrNull(b.consent_sms ?? b.sms);
    const c_whatsapp = toBoolOrNull(b.consent_whatsapp ?? b.whatsapp);
    const c_email = toBoolOrNull(b.consent_email ?? b.email);

    const anyProvided = [c_marketing, c_sms, c_whatsapp, c_email].some((x) => x !== null);
    if (!anyProvided && full_name === null) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error:
          "No consent fields provided (send at least one of whatsapp/sms/email/marketing OR consent_marketing/consent_sms/consent_whatsapp/consent_email OR full_name).",
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

// ==================== SEGMENTS + AUDIENCE ====================

function segmentFromDays(daysSince) {
  if (daysSince === null || daysSince === undefined) return "UNKNOWN";
  const n = Number(daysSince);
  if (!Number.isFinite(n)) return "UNKNOWN";
  if (n <= 14) return "ACTIVE";
  if (n <= 30) return "WARM";
  return "COLD";
}

/**
 * GET /segments?days=60
 * ✅ PREMIUM FORMAT:
 * counts + data{vip, active, warm, cold, unknown}
 */
app.get("/segments", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 60), 1), 3650);
    const today = await getTodayAL();

    const q = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
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
        AND last_seen_at IS NOT NULL
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

/**
 * GET /audience/export?channel=whatsapp&segment=all&days=60&limit=200&format=json|csv
 * channel: whatsapp | sms | email | marketing
 * segment: active | warm | cold | all
 */
app.get("/audience/export", requireApiKey, requireDbReady, async (req, res) => {
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
        id,
        restaurant_id,
        phone,
        full_name,
        visits_count,
        last_seen_at,
        ${consentColumn} AS consent_ok,
        ( ($1::date) - ((last_seen_at AT TIME ZONE 'Europe/Tirane')::date) )::int AS days_since_last_visit
      FROM public.customers
      WHERE restaurant_id = $2
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
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

// ==================== OWNER VIEW (READ ONLY) ====================

app.get("/owner/customers", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const result = await pool.query(
      `
      SELECT *
      FROM public.owner_customers
      WHERE restaurant_id = $1
      ORDER BY last_seen_at DESC NULLS LAST, visits_count DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: result.rows });
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
      SELECT *
      FROM public.owner_reservations
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

app.get("/events/upcoming", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = await getTodayAL();
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days]))
      .rows[0].d;

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id = $1
        AND event_date::date >= $2::date
        AND event_date::date <= $3::date
      ORDER BY event_date ASC, event_time ASC, created_at ASC;
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
    console.error("❌ GET /events/upcoming error:", err);
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
        return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${f}` });
      }
    }

    const people = Number(r.people);
    if (!Number.isFinite(people) || people <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be a positive number" });
    }

    const dateStr = String(r.date).trim(); // "YYYY-MM-DD"
    const timeStr = normalizeTimeHHMI(r.time);
    const status = people > MAX_AUTO_CONFIRM_PEOPLE ? "Pending" : "Confirmed";
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

    // ✅ AUTO-SYNC INTO CUSTOMERS (CRM) – non-blocking
    try {
      await pool.query(
        `
        WITH ev AS (
          SELECT (($1::date + $2::time) AT TIME ZONE 'Europe/Tirane') AS ts
        )
        INSERT INTO public.customers (
          restaurant_id, phone, full_name,
          first_seen_at, last_seen_at, visits_count,
          consent_marketing, consent_source, consent_updated_at
        )
        SELECT
          $3::bigint,
          $4::text,
          NULLIF($5::text, ''),
          (SELECT ts FROM ev),
          (SELECT ts FROM ev),
          1,
          FALSE,
          'reservation',
          NOW()
        ON CONFLICT (restaurant_id, phone)
        DO UPDATE SET
          full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.customers.full_name),
          last_seen_at = GREATEST(public.customers.last_seen_at, EXCLUDED.last_seen_at),
          visits_count = public.customers.visits_count + 1,
          updated_at = NOW();
        `,
        [dateStr, timeStr, req.restaurant_id, r.phone, r.customer_name]
      );
    } catch (e) {
      console.error("⚠️ Sync to customers failed (non-blocking):", e.message);
    }

    // ✅ SYNC INTO EVENTS (CORE) – non-blocking
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

    const row = result.rows[0];
    const httpStatus = status === "Pending" ? 202 : 201;

    return res.status(httpStatus).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message:
        status === "Pending"
          ? `Reservation is pending owner approval (people > ${MAX_AUTO_CONFIRM_PEOPLE}).`
          : "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
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

    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: err.message,
      code: err.code || null,
    });
  }
});

app.get("/reservations", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);

    const result = await pool.query(
      `
      SELECT
        id,
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
        status,
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
    console.error("❌ GET /reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.get("/reservations/upcoming", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = await getTodayAL();
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days]))
      .rows[0].d;

    const result = await pool.query(
      `
      SELECT
        id,
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
        status,
        created_at
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

// Owner actions: approve/reject (manual) - KEEP api-key, but tied to restaurant_id
app.post("/reservations/:id/approve", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const result = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Confirmed'
      WHERE restaurant_id = $1 AND id = $2
      RETURNING id, reservation_id, status, created_at;
      `,
      [req.restaurant_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
    }

    const row = result.rows[0];

    try {
      await pool.query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync approve to events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation approved (Confirmed).",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/approve error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/reservations/:id/reject", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const result = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Rejected'
      WHERE restaurant_id = $1 AND id = $2
      RETURNING id, reservation_id, status, created_at;
      `,
      [req.restaurant_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
    }

    const row = result.rows[0];

    try {
      await pool.query(`UPDATE public.events SET status='Rejected' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync reject to events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation rejected.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/reject error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
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

    const result = await pool.query(
      `
      INSERT INTO public.feedback
        (restaurant_id, restaurant_name, phone,
         location_rating, hospitality_rating, food_rating, price_rating, comment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, created_at;
      `,
      [
        req.restaurant_id,
        "Te Ta Gastronomi",
        phone,
        ratings.location_rating,
        ratings.hospitality_rating,
        ratings.food_rating,
        ratings.price_rating,
        req.body.comment || "",
      ]
    );

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

app.get("/reports/today", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const today = await getTodayAL();

    const reservations = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone, date, time, people, channel, area,
        first_time, allergies, special_requests, status, created_at
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
        comment, created_at
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
        : Math.round((feedbackRows.reduce((s, x) => s + Number(x.avg_rating), 0) / feedbackCount) * 10) / 10;

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

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
