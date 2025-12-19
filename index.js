require("dotenv").config();
process.env.TZ = "Europe/Tirane";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ==================== CONFIG ====================
const RESTAURANT_ID = Number(process.env.RESTAURANT_ID || 2);
const MAX_AUTO_CONFIRM_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 8);
const APP_VERSION = "v-2025-12-19-core-events-crm-pro";

// ==================== HELPERS ====================
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

function clampInt(x, min, max, fallback) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === "") return f;
  }
  return null;
}

function safeText(v, maxLen = 500) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}

function isValidTime(s) {
  // Accept HH:MM or HH:MM:SS
  return /^\d{2}:\d{2}(:\d{2})?$/.test(String(s || "").trim());
}

// ==================== API KEY ====================
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
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

    // customers (create minimal if missing, then migrate safely)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.customers (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS visits_count INT NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMP NULL;`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_source TEXT NULL;`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';`);

    // Unique index (restaurant_id, phone) => needed for ON CONFLICT
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_unique_phone
      ON public.customers (restaurant_id, phone);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_restaurant_visits
      ON public.customers (restaurant_id, visits_count DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_restaurant_last_visit
      ON public.customers (restaurant_id, last_visit_at DESC);
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

    // reservations (legacy)
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

    // Safe migrations for reservations
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

    // events (CORE)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.events (
        id SERIAL PRIMARY KEY,

        restaurant_id INTEGER NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        customer_id INTEGER NULL REFERENCES public.customers(id) ON DELETE SET NULL,
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

    // indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_restaurant_date ON public.events (restaurant_id, event_date);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON public.events (status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_reservation_id ON public.events (reservation_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_customer_id ON public.events (customer_id);`);

    console.log("✅ DB ready (migrations applied)");
  } catch (err) {
    console.error("❌ initDb error:", err);
  }
}
initDb();

// ==================== CRM CORE ====================
async function getOrCreateCustomer({ restaurant_id, full_name, phone, source }) {
  const p = String(phone || "").trim();
  if (!p) return null;

  const name = safeText(full_name || "", 120).trim();
  const src = safeText(source || "", 60).trim();

  const q = await pool.query(
    `
    INSERT INTO public.customers (restaurant_id, full_name, phone, last_source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (restaurant_id, phone)
    DO UPDATE SET
      full_name = CASE
        WHEN public.customers.full_name = '' AND EXCLUDED.full_name <> '' THEN EXCLUDED.full_name
        ELSE public.customers.full_name
      END,
      last_source = CASE
        WHEN EXCLUDED.last_source <> '' THEN EXCLUDED.last_source
        ELSE public.customers.last_source
      END
    RETURNING id, restaurant_id, full_name, phone, visits_count, last_visit_at, last_source, created_at;
    `,
    [restaurant_id, name, p, src]
  );

  return q.rows[0];
}

async function touchCustomerVisit({ restaurant_id, customer_id, event_date, event_time }) {
  if (!customer_id) return;
  await pool.query(
    `
    UPDATE public.customers
    SET
      visits_count = visits_count + 1,
      last_visit_at = COALESCE((($3::date + $4::time)), last_visit_at)
    WHERE restaurant_id = $1 AND id = $2;
    `,
    [restaurant_id, customer_id, String(event_date).trim(), String(event_time).trim()]
  );
}

// ==================== HEALTH ====================
app.get("/", (req, res) => {
  res.status(200).send(`Te Ta Backend is running ✅ (${APP_VERSION})`);
});

app.get("/health/db", requireApiKey, async (req, res) => {
  const r = await pool.query("SELECT NOW() as now");
  res.json({
    success: true,
    version: APP_VERSION,
    now: r.rows[0].now,
    now_local: formatALDate(r.rows[0].now),
    restaurant_id: RESTAURANT_ID,
    max_auto_confirm_people: MAX_AUTO_CONFIRM_PEOPLE,
  });
});

// ==================== DEBUG ====================
app.get("/debug/schema", requireApiKey, async (req, res) => {
  const table = String(req.query.table || "").trim();
  if (!table) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing table" });

  const q = await pool.query(
    `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position;
    `,
    [table]
  );

  res.json({ success: true, version: APP_VERSION, table, columns: q.rows });
});

app.get("/debug/constraints", requireApiKey, async (req, res) => {
  const table = String(req.query.table || "").trim();
  if (!table) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing table" });

  const q = await pool.query(
    `
    SELECT
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = con.connamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = $1
    ORDER BY con.conname;
    `,
    [table]
  );

  res.json({ success: true, version: APP_VERSION, table, constraints: q.rows });
});

// ==================== CUSTOMERS (CRM) ====================
// GET /customers?limit=20
app.get("/customers", requireApiKey, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 200, 20);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, last_source, notes, created_at
      FROM public.customers
      WHERE restaurant_id = $1
      ORDER BY visits_count DESC, last_visit_at DESC NULLS LAST, created_at DESC
      LIMIT $2;
      `,
      [RESTAURANT_ID, limit]
    );

    const rows = q.rows.map((c) => ({
      ...c,
      last_visit_at_local: c.last_visit_at ? formatALDate(c.last_visit_at) : null,
      created_at_local: formatALDate(c.created_at),
    }));

    return res.json({ success: true, version: APP_VERSION, count: rows.length, data: rows });
  } catch (err) {
    console.error("❌ GET /customers error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /customers/vip?min_visits=3&limit=50
app.get("/customers/vip", requireApiKey, async (req, res) => {
  try {
    const min = clampInt(req.query.min_visits, 1, 9999, 3);
    const limit = clampInt(req.query.limit, 1, 200, 50);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, last_source, created_at
      FROM public.customers
      WHERE restaurant_id = $1 AND visits_count >= $2
      ORDER BY visits_count DESC, last_visit_at DESC NULLS LAST
      LIMIT $3;
      `,
      [RESTAURANT_ID, min, limit]
    );

    const rows = q.rows.map((c) => ({
      ...c,
      last_visit_at_local: c.last_visit_at ? formatALDate(c.last_visit_at) : null,
      created_at_local: formatALDate(c.created_at),
    }));

    return res.json({ success: true, version: APP_VERSION, min_visits: min, count: rows.length, data: rows });
  } catch (err) {
    console.error("❌ GET /customers/vip error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /customers/by-phone?phone=069...
app.get("/customers/by-phone", requireApiKey, async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing phone" });

    const q = await pool.query(
      `
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, last_source, notes, created_at
      FROM public.customers
      WHERE restaurant_id = $1 AND phone = $2
      LIMIT 1;
      `,
      [RESTAURANT_ID, phone]
    );

    if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });

    const c = q.rows[0];
    return res.json({
      success: true,
      version: APP_VERSION,
      data: {
        ...c,
        last_visit_at_local: c.last_visit_at ? formatALDate(c.last_visit_at) : null,
        created_at_local: formatALDate(c.created_at),
      },
    });
  } catch (err) {
    console.error("❌ GET /customers/by-phone error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /customers/insights
app.get("/customers/insights", requireApiKey, async (req, res) => {
  try {
    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;

    const totalCustomers = (await pool.query(`SELECT COUNT(*)::int AS n FROM public.customers WHERE restaurant_id=$1`, [
      RESTAURANT_ID,
    ])).rows[0].n;

    const new7d = (await pool.query(
      `
      SELECT COUNT(*)::int AS n
      FROM public.customers
      WHERE restaurant_id=$1
        AND (created_at AT TIME ZONE 'Europe/Tirane')::date >= ($2::date - INTERVAL '7 days')::date;
      `,
      [RESTAURANT_ID, today]
    )).rows[0].n;

    const vip3 = (await pool.query(
      `
      SELECT COUNT(*)::int AS n
      FROM public.customers
      WHERE restaurant_id=$1 AND visits_count >= 3;
      `,
      [RESTAURANT_ID]
    )).rows[0].n;

    const topVip = await pool.query(
      `
      SELECT id, full_name, phone, visits_count, last_visit_at
      FROM public.customers
      WHERE restaurant_id=$1
      ORDER BY visits_count DESC, last_visit_at DESC NULLS LAST
      LIMIT 10;
      `,
      [RESTAURANT_ID]
    );

    const topVipRows = topVip.rows.map((c) => ({
      ...c,
      last_visit_at_local: c.last_visit_at ? formatALDate(c.last_visit_at) : null,
    }));

    return res.json({
      success: true,
      version: APP_VERSION,
      date_local: today,
      insights: {
        total_customers: totalCustomers,
        new_customers_last_7_days: new7d,
        vip_customers_visits_ge_3: vip3,
      },
      top_vip_10: topVipRows,
    });
  } catch (err) {
    console.error("❌ GET /customers/insights error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== EVENTS (CORE) ====================

// POST /events
app.post("/events", requireApiKey, async (req, res) => {
  try {
    const b = req.body || {};

    const missing = requireFields(b, ["event_date", "event_time"]);
    if (missing) return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${missing}` });

    const restaurant_id = Number(b.restaurant_id || RESTAURANT_ID);
    if (!Number.isFinite(restaurant_id)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "restaurant_id invalid" });
    }

    const event_date = String(b.event_date).trim();
    const event_time = String(b.event_time).trim();
    if (!isValidYMD(event_date)) return res.status(400).json({ success: false, version: APP_VERSION, error: "event_date must be YYYY-MM-DD" });
    if (!isValidTime(event_time)) return res.status(400).json({ success: false, version: APP_VERSION, error: "event_time must be HH:MM or HH:MM:SS" });

    const people = b.people === undefined || b.people === null || b.people === "" ? null : Number(b.people);
    if (people !== null && (!Number.isFinite(people) || people <= 0)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be positive number" });
    }

    const status = safeText(b.status || "Pending", 20);
    const source = safeText(b.source || b.channel || "", 50) || null;

    // CRM: if phone provided, link/create customer
    const phone = b.phone ? String(b.phone).trim() : "";
    const customer_name = safeText(b.customer_name || b.full_name || "", 120);
    const customer = phone ? await getOrCreateCustomer({ restaurant_id, full_name: customer_name, phone, source }) : null;
    const customer_id = customer ? customer.id : (b.customer_id || null);

    const result = await pool.query(
      `
      INSERT INTO public.events
      (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
      VALUES
      ($1,$2,$3,$4,$5::date,$6::time,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, created_at, customer_id, status;
      `,
      [
        restaurant_id,
        customer_id || null,
        b.reservation_id || null,
        safeText(b.event_type || "restaurant_reservation", 50),
        event_date,
        event_time,
        people,
        status || "Pending",
        source,
        safeText(b.area || "", 50) || null,
        safeText(b.allergies ?? "", 500) || "",
        safeText(b.special_requests ?? "", 800) || "",
        safeText(b.notes ?? "", 1000) || "",
        safeText(b.created_by || "AI", 20),
      ]
    );

    const row = result.rows[0];

    // Update CRM stats only for Confirmed/Pending? (ne e rrisim për çdo event të futur)
    if (customer_id) {
      try {
        await touchCustomerVisit({ restaurant_id, customer_id, event_date, event_time });
      } catch (e) {
        console.error("⚠️ touchCustomerVisit failed (non-blocking):", e.message);
      }
    }

    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

// GET /events?limit=10
app.get("/events", requireApiKey, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 200, 10);

    const result = await pool.query(
      `
      SELECT
        e.id, e.restaurant_id, e.customer_id, e.reservation_id,
        e.event_type, e.event_date, e.event_time, e.people,
        e.status, e.source, e.area, e.allergies, e.special_requests, e.notes,
        e.created_by, e.created_at,
        c.full_name as customer_name,
        c.phone as customer_phone,
        c.visits_count as customer_visits
      FROM public.events e
      LEFT JOIN public.customers c ON c.id = e.customer_id
      WHERE e.restaurant_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2;
      `,
      [RESTAURANT_ID, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, count: rows.length, data: rows });
  } catch (err) {
    console.error("❌ GET /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /events/upcoming?days=30
app.get("/events/upcoming", requireApiKey, async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days]))
      .rows[0].d;

    const result = await pool.query(
      `
      SELECT
        e.id, e.restaurant_id, e.customer_id, e.reservation_id,
        e.event_type, e.event_date, e.event_time, e.people,
        e.status, e.source, e.area, e.allergies, e.special_requests, e.notes,
        e.created_by, e.created_at,
        c.full_name as customer_name,
        c.phone as customer_phone,
        c.visits_count as customer_visits
      FROM public.events e
      LEFT JOIN public.customers c ON c.id = e.customer_id
      WHERE e.restaurant_id = $1
        AND e.event_date::date >= $2::date
        AND e.event_date::date <= $3::date
      ORDER BY e.event_date ASC, e.event_time ASC, e.created_at ASC;
      `,
      [RESTAURANT_ID, today, end]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({
      success: true,
      version: APP_VERSION,
      range: { from: today, to: end, days },
      restaurant_id: RESTAURANT_ID,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /events/upcoming error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// Approve / Reject EVENT (optional but pro)
app.post("/events/:id/approve", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const q = await pool.query(
      `
      UPDATE public.events
      SET status='Confirmed'
      WHERE restaurant_id=$1 AND id=$2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Event not found" });

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Event approved (Confirmed).",
      data: { ...q.rows[0], created_at_local: formatALDate(q.rows[0].created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events/:id/approve error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/events/:id/reject", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const q = await pool.query(
      `
      UPDATE public.events
      SET status='Rejected'
      WHERE restaurant_id=$1 AND id=$2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Event not found" });

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Event rejected.",
      data: { ...q.rows[0], created_at_local: formatALDate(q.rows[0].created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events/:id/reject error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== RESERVATIONS (LEGACY → SYNC TO EVENTS + CRM) ====================
app.post("/reservations", requireApiKey, async (req, res) => {
  try {
    const r = req.body || {};
    const missing = requireFields(r, ["customer_name", "phone", "date", "time", "people"]);
    if (missing) return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${missing}` });

    const dateStr = String(r.date).trim();
    const timeStr = String(r.time).trim();
    if (!isValidYMD(dateStr)) return res.status(400).json({ success: false, version: APP_VERSION, error: "date must be YYYY-MM-DD" });
    if (!isValidTime(timeStr)) return res.status(400).json({ success: false, version: APP_VERSION, error: "time must be HH:MM or HH:MM:SS" });

    const people = Number(r.people);
    if (!Number.isFinite(people) || people <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be a positive number" });
    }

    const status = people > MAX_AUTO_CONFIRM_PEOPLE ? "Pending" : "Confirmed";
    const reservation_id = r.reservation_id || crypto.randomUUID();
    const source = safeText(r.channel || r.source || "", 50) || null;

    // CRM customer
    const customer = await getOrCreateCustomer({
      restaurant_id: RESTAURANT_ID,
      full_name: safeText(r.customer_name, 120),
      phone: String(r.phone).trim(),
      source,
    });
    const customer_id = customer ? customer.id : null;

    const ins = await pool.query(
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
        RESTAURANT_ID,
        reservation_id,
        r.restaurant_name || "Te Ta Gastronomi",
        safeText(r.customer_name, 120),
        String(r.phone).trim(),
        dateStr,
        timeStr,
        people,
        source,
        safeText(r.area || "", 50) || null,
        safeText(r.first_time || "", 20) || null,
        safeText(r.allergies ?? "", 500) || "",
        safeText(r.special_requests ?? "", 800) || "",
        r,
        status,
      ]
    );

    // Sync to events (non-blocking, but we try hard)
    try {
      await pool.query(
        `
        INSERT INTO public.events
        (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
        VALUES
        ($1,$2,$3,'restaurant_reservation',$4::date,$5::time,$6,$7,$8,$9,$10,$11,$12,$13);
        `,
        [
          RESTAURANT_ID,
          customer_id,
          reservation_id,
          dateStr,
          timeStr,
          people,
          status,
          source,
          safeText(r.area || "", 50) || null,
          safeText(r.allergies ?? "", 500) || "",
          safeText(r.special_requests ?? "", 800) || "",
          "Synced from /reservations",
          "AI",
        ]
      );
    } catch (e) {
      console.error("⚠️ Sync reservations->events failed (non-blocking):", e.message);
    }

    // update CRM stats
    if (customer_id) {
      try {
        await touchCustomerVisit({ restaurant_id: RESTAURANT_ID, customer_id, event_date: dateStr, event_time: timeStr });
      } catch (e) {
        console.error("⚠️ touchCustomerVisit failed (non-blocking):", e.message);
      }
    }

    const row = ins.rows[0];
    return res.status(status === "Pending" ? 202 : 201).json({
      success: true,
      version: APP_VERSION,
      message: status === "Pending" ? `Reservation pending approval (people > ${MAX_AUTO_CONFIRM_PEOPLE}).` : "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at), customer_id, status },
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

// GET /reservations?limit=10
app.get("/reservations", requireApiKey, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 100, 10);

    const q = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone, date, time, people,
        channel, area, first_time, allergies, special_requests,
        status, created_at
      FROM public.reservations
      WHERE restaurant_id=$1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [RESTAURANT_ID, limit]
    );

    const rows = q.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, count: rows.length, data: rows });
  } catch (err) {
    console.error("❌ GET /reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /reservations/upcoming?days=30
app.get("/reservations/upcoming", requireApiKey, async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);

    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days]))
      .rows[0].d;

    const q = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone, date, time, people,
        channel, area, first_time, allergies, special_requests,
        status, created_at
      FROM public.reservations
      WHERE restaurant_id=$1
        AND date::date >= $2::date
        AND date::date <= $3::date
      ORDER BY date ASC, time ASC, created_at ASC;
      `,
      [RESTAURANT_ID, today, end]
    );

    const rows = q.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({
      success: true,
      version: APP_VERSION,
      range: { from: today, to: end, days },
      restaurant_id: RESTAURANT_ID,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /reservations/upcoming error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// Owner approve/reject reservations + sync events
app.post("/reservations/:id/approve", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const q = await pool.query(
      `
      UPDATE public.reservations
      SET status='Confirmed'
      WHERE restaurant_id=$1 AND id=$2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });

    // sync event status by reservation_id
    try {
      await pool.query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        RESTAURANT_ID,
        q.rows[0].reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync reservation approve -> events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Reservation approved (Confirmed).",
      data: { ...q.rows[0], created_at_local: formatALDate(q.rows[0].created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/approve error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

app.post("/reservations/:id/reject", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const q = await pool.query(
      `
      UPDATE public.reservations
      SET status='Rejected'
      WHERE restaurant_id=$1 AND id=$2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });

    try {
      await pool.query(`UPDATE public.events SET status='Rejected' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        RESTAURANT_ID,
        q.rows[0].reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync reservation reject -> events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Reservation rejected.",
      data: { ...q.rows[0], created_at_local: formatALDate(q.rows[0].created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/reject error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== FEEDBACK ====================
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

// POST /feedback
app.post("/feedback", requireApiKey, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const ratings = normalizeFeedbackRatings(req.body || {});
    if (Object.values(ratings).some((v) => v === null)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Ratings must be numbers between 1 and 5" });
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
        RESTAURANT_ID,
        "Te Ta Gastronomi",
        phone,
        ratings.location_rating,
        ratings.hospitality_rating,
        ratings.food_rating,
        ratings.price_rating,
        safeText(req.body?.comment || "", 800),
      ]
    );

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /feedback?limit=20
app.get("/feedback", requireApiKey, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 200, 20);

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, restaurant_name, phone,
        location_rating, hospitality_rating, food_rating, price_rating,
        ROUND((location_rating + hospitality_rating + food_rating + price_rating) / 4.0, 1) AS avg_rating,
        comment, created_at
      FROM public.feedback
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [RESTAURANT_ID, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, count: rows.length, data: rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== REPORTS ====================

// GET /reports/today (events + feedback)
app.get("/reports/today", requireApiKey, async (req, res) => {
  try {
    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;

    const eventsQ = await pool.query(
      `
      SELECT
        e.id, e.restaurant_id, e.customer_id, e.reservation_id,
        e.event_type, e.event_date, e.event_time, e.people,
        e.status, e.source, e.area, e.allergies, e.special_requests, e.notes,
        e.created_by, e.created_at,
        c.full_name as customer_name,
        c.phone as customer_phone,
        c.visits_count as customer_visits
      FROM public.events e
      LEFT JOIN public.customers c ON c.id = e.customer_id
      WHERE e.restaurant_id = $1
        AND e.event_date::date = $2::date
      ORDER BY e.event_time ASC, e.created_at ASC;
      `,
      [RESTAURANT_ID, today]
    );

    const eventsRows = eventsQ.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    const total = eventsRows.length;
    const confirmed = eventsRows.filter((x) => x.status === "Confirmed").length;
    const pending = eventsRows.filter((x) => x.status === "Pending").length;
    const rejected = eventsRows.filter((x) => x.status === "Rejected").length;
    const totalPeople = eventsRows.reduce((s, x) => s + (Number(x.people) || 0), 0);

    const feedbackQ = await pool.query(
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
      [RESTAURANT_ID, today]
    );

    const feedbackRows = feedbackQ.rows.map((f) => ({ ...f, created_at_local: formatALDate(f.created_at) }));
    const feedbackCount = feedbackRows.length;
    const avgOfAvg =
      feedbackCount === 0
        ? null
        : Math.round((feedbackRows.reduce((s, x) => s + Number(x.avg_rating), 0) / feedbackCount) * 10) / 10;

    return res.json({
      success: true,
      version: APP_VERSION,
      date_local: today,
      restaurant_id: RESTAURANT_ID,
      summary: {
        events_today: total,
        confirmed,
        pending,
        rejected,
        total_people: totalPeople,
        feedback_today: feedbackCount,
        avg_rating_today: avgOfAvg,
      },
      events: eventsRows,
      feedback: feedbackRows,
    });
  } catch (err) {
    console.error("❌ GET /reports/today error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /reports/today-events (events only)
app.get("/reports/today-events", requireApiKey, async (req, res) => {
  try {
    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;

    const q = await pool.query(
      `
      SELECT
        id, restaurant_id, customer_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id=$1
        AND event_date::date = $2::date
      ORDER BY event_time ASC, created_at ASC;
      `,
      [RESTAURANT_ID, today]
    );

    const rows = q.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    const total = rows.length;
    const confirmed = rows.filter((x) => x.status === "Confirmed").length;
    const pending = rows.filter((x) => x.status === "Pending").length;
    const rejected = rows.filter((x) => x.status === "Rejected").length;
    const totalPeople = rows.reduce((s, x) => s + (Number(x.people) || 0), 0);

    return res.json({
      success: true,
      version: APP_VERSION,
      date_local: today,
      restaurant_id: RESTAURANT_ID,
      summary: { events_today: total, confirmed, pending, rejected, total_people: totalPeople },
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /reports/today-events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
