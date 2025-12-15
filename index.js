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
    // feedback table (already)
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

    // ✅ add status column to reservations (non-breaking)
    await pool.query(`
      ALTER TABLE public.reservations
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Confirmed';
    `);

    console.log("✅ DB ready (feedback + reservations.status)");
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
  res.status(200).send("Te Ta Backend is running ✅");
});

app.get("/health/db", requireApiKey, async (req, res) => {
  const r = await pool.query("SELECT NOW() as now");
  res.json({
    success: true,
    now: r.rows[0].now,
    now_local: formatALDate(r.rows[0].now),
    restaurant_id: RESTAURANT_ID,
    max_auto_confirm_people: MAX_AUTO_CONFIRM_PEOPLE,
  });
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

  // ratings object: {location, hospitality, food, price}
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

  // single rating -> replicate to all 4
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

// ==================== RESERVATIONS ====================

// POST /reservations
// Rule: if people > MAX_AUTO_CONFIRM_PEOPLE => status = 'Pending' (owner must approve)
app.post("/reservations", requireApiKey, async (req, res) => {
  try {
    const r = req.body;
    const required = ["customer_name", "phone", "date", "time", "people"];
    for (const f of required) {
      if (!r[f]) {
        return res.status(400).json({ success: false, error: `Missing field: ${f}` });
      }
    }

    const people = Number(r.people);
    if (!Number.isFinite(people) || people <= 0) {
      return res.status(400).json({ success: false, error: "people must be a positive number" });
    }

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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, reservation_id, created_at, status;
      `,
      [
        RESTAURANT_ID,
        reservation_id,
        r.restaurant_name || "Te Ta Gastronomi",
        r.customer_name,
        r.phone,
        r.date,
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

    const row = result.rows[0];

    // If pending, return 202 Accepted (created but not confirmed)
    const httpStatus = status === "Pending" ? 202 : 201;

    res.status(httpStatus).json({
      success: true,
      message:
        status === "Pending"
          ? `Reservation is pending owner approval (people > ${MAX_AUTO_CONFIRM_PEOPLE}).`
          : "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations error:", err);
    res.status(500).json({ success: false, error: "DB insert failed" });
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

    const rows = result.rows.map((r) => ({
      ...r,
      created_at_local: formatALDate(r.created_at),
    }));

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ GET /reservations error:", err);
    res.status(500).json({ success: false, error: "DB read failed" });
  }
});

// GET /reservations/upcoming?days=30
app.get("/reservations/upcoming", requireApiKey, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = (
      await pool.query(`
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d
      `)
    ).rows[0].d;

    const end = (
      await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [
        today,
        days,
      ])
    ).rows[0].d;

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

    const rows = result.rows.map((r) => ({
      ...r,
      created_at_local: formatALDate(r.created_at),
    }));

    res.json({
      success: true,
      range: { from: today, to: end, days },
      restaurant_id: RESTAURANT_ID,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /reservations/upcoming error:", err);
    res.status(500).json({ success: false, error: "DB read failed" });
  }
});

// Owner actions (manual confirmation)
app.post("/reservations/:id/approve", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

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
      return res.status(404).json({ success: false, error: "Reservation not found" });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      message: "Reservation approved (Confirmed).",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/approve error:", err);
    res.status(500).json({ success: false, error: "DB update failed" });
  }
});

app.post("/reservations/:id/reject", requireApiKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

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
      return res.status(404).json({ success: false, error: "Reservation not found" });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      message: "Reservation rejected.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations/:id/reject error:", err);
    res.status(500).json({ success: false, error: "DB update failed" });
  }
});

// ==================== FEEDBACK ====================

// POST /feedback
app.post("/feedback", requireApiKey, async (req, res) => {
  try {
    const phone = req.body.phone;
    if (!phone) {
      return res.status(400).json({ success: false, error: "Missing field: phone" });
    }

    const ratings = normalizeFeedbackRatings(req.body);
    if (Object.values(ratings).some((v) => v === null)) {
      return res.status(400).json({
        success: false,
        error: "Ratings must be numbers between 1 and 5",
      });
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
    res.status(201).json({
      success: true,
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /feedback error:", err);
    res.status(500).json({ success: false, error: "DB insert failed" });
  }
});

// GET /feedback?limit=20
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

    const rows = result.rows.map((r) => ({
      ...r,
      created_at_local: formatALDate(r.created_at),
    }));

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    res.status(500).json({ success: false, error: "DB read failed" });
  }
});

// ==================== REPORTS ====================

// GET /reports/today
app.get("/reports/today", requireApiKey, async (req, res) => {
  try {
    const today = (
      await pool.query(`
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date AS d
      `)
    ).rows[0].d;

    // ✅ Reservations "today" = service date (date column), not created_at
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
      [RESTAURANT_ID, today]
    );

    const reservationsRows = reservations.rows.map((r) => ({
      ...r,
      created_at_local: formatALDate(r.created_at),
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
        : Math.round(
            (feedbackRows.reduce((s, x) => s + Number(x.avg_rating), 0) / feedbackCount) * 10
          ) / 10;

    const fiveStars =
      feedbackCount === 0 ? 0 : feedbackRows.filter((x) => Number(x.avg_rating) >= 5).length;

    const fiveStarsPct =
      feedbackCount === 0 ? 0 : Math.round((fiveStars / feedbackCount) * 100);

    return res.json({
      success: true,
      date_local: today,
      restaurant_id: RESTAURANT_ID,
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
    return res.status(500).json({ success: false, error: "Report failed" });
  }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
