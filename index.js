require("dotenv").config();
process.env.TZ = "Europe/Tirane";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const RESTAURANT_ID = Number(process.env.RESTAURANT_ID || 2);
const MAX_AUTO_CONFIRM_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 8);

// ✅ FINAL version marker
const APP_VERSION = "v-2025-12-19-events-crm-final-fix1";

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

    // customers (CRM) - create if missing
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.customers (
        id SERIAL PRIMARY KEY,
        restaurant_id INT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ✅ MIGRATIONS for existing customers table (safe)
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS visits_count INT NOT NULL DEFAULT 0;`);
    await pool.query(`ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_visit_at TIMESTAMP NULL;`);

    // ✅ Unique on (restaurant_id, phone) as unique index (works with ON CONFLICT (restaurant_id, phone))
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_unique_phone
      ON public.customers (restaurant_id, phone);
    `);

    // helpful indexes
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

    // reservations (legacy/compat)
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

    // Ensure columns exist (non-breaking).
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
    await pool.query(
      `ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Confirmed';`
    );

    // EVENTS (CORE)
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_restaurant_date
      ON public.events (restaurant_id, event_date);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_status
      ON public.events (status);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_reservation_id
      ON public.events (reservation_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_customer_id
      ON public.events (customer_id);
    `);

    console.log("✅ DB ready (migrations applied)");
  } catch (err) {
    console.error("❌ initDb error:", err);
  }
}
initDb();

// ==================== API KEY ====================
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

// ==================== CRM HELPERS ====================
async function getOrCreateCustomer(restaurant_id, full_name, phone) {
  const name = (full_name || "").trim();
  const p = String(phone || "").trim();
  if (!p) return null;

  const q = await pool.query(
    `
    INSERT INTO public.customers (restaurant_id, full_name, phone)
    VALUES ($1, $2, $3)
    ON CONFLICT (restaurant_id, phone)
    DO UPDATE SET
      full_name = CASE
        WHEN public.customers.full_name = '' AND EXCLUDED.full_name <> '' THEN EXCLUDED.full_name
        ELSE public.customers.full_name
      END
    RETURNING id, restaurant_id, full_name, phone, visits_count, last_visit_at, created_at;
    `,
    [restaurant_id, name, p]
  );

  return q.rows[0];
}

async function touchCustomerVisit(restaurant_id, customer_id, event_date, event_time) {
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

// ==================== CUSTOMERS (CRM) ====================

// GET /customers?limit=20
app.get("/customers", requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, created_at
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

    return res.json({ success: true, version: APP_VERSION, data: rows });
  } catch (err) {
    console.error("❌ GET /customers error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /customers/vip?min_visits=3
app.get("/customers/vip", requireApiKey, async (req, res) => {
  try {
    const min = Math.min(Math.max(Number(req.query.min_visits || 3), 1), 9999);
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, created_at
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
      SELECT id, restaurant_id, full_name, phone, visits_count, last_visit_at, created_at
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

// ==================== EVENTS (CORE) ====================

// POST /events
app.post("/events", requireApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["event_date", "event_time"];
    for (const f of required) {
      if (!b[f]) {
        return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${f}` });
      }
    }

    const restaurant_id = Number(b.restaurant_id || RESTAURANT_ID);
    if (!Number.isFinite(restaurant_id)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "restaurant_id invalid" });
    }

    const people = b.people === undefined || b.people === null || b.people === "" ? null : Number(b.people);
    if (people !== null && (!Number.isFinite(people) || people <= 0)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be positive number" });
    }

    const status = b.status || "Pending";

    // ✅ CRM: create/find customer if phone exists
    const phone = b.phone || null;
    const full_name = b.customer_name || b.full_name || "";
    const customer = phone ? await getOrCreateCustomer(restaurant_id, full_name, phone) : null;
    const customer_id = customer ? customer.id : null;

    const result = await pool.query(
      `
      INSERT INTO public.events
      (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
      VALUES
      ($1,$2,$3,$4,$5::date,$6::time,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, created_at, customer_id;
      `,
      [
        restaurant_id,
        customer_id,
        b.reservation_id || null,
        b.event_type || "restaurant_reservation",
        String(b.event_date).trim(),
        String(b.event_time).trim(),
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

    if (customer_id) {
      try {
        await touchCustomerVisit(restaurant_id, customer_id, b.event_date, b.event_time);
      } catch (e) {
        console.error("⚠️ touchCustomerVisit failed (non-blocking):", e.message);
      }
    }

    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      data: {
        id: row.id,
        customer_id: row.customer_id,
        created_at: row.created_at,
        created_at_local: formatALDate(row.created_at),
      },
    });
  } catch (err) {
    console.error("❌ POST /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

// GET /events?limit=10
app.get("/events", requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 100);

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
    return res.json({ success: true, version: APP_VERSION, data: rows });
  } catch (err) {
    console.error("❌ GET /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== RESERVATIONS (legacy/compat) ====================

app.post("/reservations", requireApiKey, async (req, res) => {
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

    const dateStr = String(r.date).trim();
    const timeStr = String(r.time).trim();
    const status = people > MAX_AUTO_CONFIRM_PEOPLE ? "Pending" : "Confirmed";
    const reservation_id = r.reservation_id || crypto.randomUUID();

    // ✅ CRM: customer
    const customer = await getOrCreateCustomer(RESTAURANT_ID, r.customer_name, r.phone);
    const customer_id = customer ? customer.id : null;

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
        RESTAURANT_ID,
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

    // ✅ Sync event with customer_id
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

    // ✅ Update visit stats
    if (customer_id) {
      try {
        await touchCustomerVisit(RESTAURANT_ID, customer_id, dateStr, timeStr);
      } catch (e) {
        console.error("⚠️ touchCustomerVisit failed (non-blocking):", e.message);
      }
    }

    const row = result.rows[0];
    const httpStatus = status === "Pending" ? 202 : 201;

    return res.status(httpStatus).json({
      success: true,
      version: APP_VERSION,
      message:
        status === "Pending"
          ? `Reservation is pending owner approval (people > ${MAX_AUTO_CONFIRM_PEOPLE}).`
          : "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at), customer_id },
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

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
