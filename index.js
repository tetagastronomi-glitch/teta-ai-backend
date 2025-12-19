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
const APP_VERSION = "v-2025-12-19-events-final";

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
    await pool.query(
      `ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Confirmed';`
    );

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

    // Indexes
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
app.get("/debug/reservations-schema", requireApiKey, async (req, res) => {
  const q = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reservations'
    ORDER BY ordinal_position;
  `);
  res.json({ success: true, version: APP_VERSION, columns: q.rows });
});

app.get("/debug/reservations-constraints", requireApiKey, async (req, res) => {
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
    res.json({ success: true, version: APP_VERSION, constraints: q.rows });
  } catch (err) {
    console.error("❌ /debug/reservations-constraints error:", err);
    res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
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

    const result = await pool.query(
      `
      INSERT INTO public.events
      (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
      VALUES
      ($1,$2,$3,$4,$5::date,$6::time,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, created_at;
      `,
      [
        restaurant_id,
        b.customer_id || null,
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
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      data: { id: row.id, created_at: row.created_at, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

// GET /events?limit=10
app.get("/events", requireApiKey, async (req, res) => {
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
      [RESTAURANT_ID, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, data: rows });
  } catch (err) {
    console.error("❌ GET /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /events/upcoming?days=30
app.get("/events/upcoming", requireApiKey, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;
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

// ==================== RESERVATIONS ====================

// POST /reservations  (auto Pending if > MAX)
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

    const dateStr = String(r.date).trim(); // YYYY-MM-DD
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
        RESTAURANT_ID,
        reservation_id,
        r.restaurant_name || "Te Ta Gastronomi",
        r.customer_name,
        r.phone,
        dateStr,
        r.time,
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

    // ✅ Sync into events (non-blocking)
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
          null,
          reservation_id,
          dateStr,
          String(r.time).trim(),
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

// GET /reservations?limit=10
app.get("/reservations", requireApiKey, async (req, res) => {
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
      [RESTAURANT_ID, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, data: rows });
  } catch (err) {
    console.error("❌ GET /reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// GET /reservations/upcoming?days=30
app.get("/reservations/upcoming", requireApiKey, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;
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
    console.error("❌ GET /reservations/upcoming error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// Owner approve/reject (manual) + sync to events
app.post("/reservations/:id/approve", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const result = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Confirmed'
      WHERE restaurant_id = $1 AND id = $2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
    }

    const row = result.rows[0];

    try {
      await pool.query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        RESTAURANT_ID,
        row.reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync approve to events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Reservation approved (Confirmed).",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
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

    const result = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Rejected'
      WHERE restaurant_id = $1 AND id = $2
      RETURNING id, reservation_id, status, created_at;
      `,
      [RESTAURANT_ID, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
    }

    const row = result.rows[0];

    try {
      await pool.query(`UPDATE public.events SET status='Rejected' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        RESTAURANT_ID,
        row.reservation_id,
      ]);
    } catch (e) {
      console.error("⚠️ Sync reject to events failed (non-blocking):", e.message);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Reservation rejected.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/reject error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== FEEDBACK ====================
app.post("/feedback", requireApiKey, async (req, res) => {
  try {
    const phone = req.body?.phone;
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const ratings = normalizeFeedbackRatings(req.body);
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
        req.body.comment || "",
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

app.get("/feedback", requireApiKey, async (req, res) => {
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
      [RESTAURANT_ID, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, data: rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== REPORTS ====================

// ✅ FINAL: GET /reports/today (events + feedback)
app.get("/reports/today", requireApiKey, async (req, res) => {
  try {
    const today = (await pool.query(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d`)).rows[0].d;

    // events today
    const eventsQ = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id = $1
        AND event_date::date = $2::date
      ORDER BY event_time ASC, created_at ASC;
      `,
      [RESTAURANT_ID, today]
    );

    const eventsRows = eventsQ.rows.map((x) => ({
      ...x,
      created_at_local: formatALDate(x.created_at),
    }));

    const total = eventsRows.length;
    const confirmed = eventsRows.filter((x) => x.status === "Confirmed").length;
    const pending = eventsRows.filter((x) => x.status === "Pending").length;
    const rejected = eventsRows.filter((x) => x.status === "Rejected").length;
    const totalPeople = eventsRows.reduce((s, x) => s + (Number(x.people) || 0), 0);

    // feedback today
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
      [RESTAURANT_ID, today]
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
      restaurant_id: RESTAURANT_ID,
      summary: {
        events_today: total,
        confirmed,
        pending,
        rejected,
        total_people: totalPeople,

        feedback_today: feedbackCount,
        avg_rating_today: avgOfAvg,
        five_star_feedback_today: fiveStars,
        five_star_pct_today: fiveStarsPct,
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

    const eventsQ = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id = $1
        AND event_date::date = $2::date
      ORDER BY event_time ASC, created_at ASC;
      `,
      [RESTAURANT_ID, today]
    );

    const rows = eventsQ.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));

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
      summary: {
        events_today: total,
        confirmed,
        pending,
        rejected,
        total_people: totalPeople,
      },
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
