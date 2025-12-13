const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- INIT DB (create feedback table if missing) ---
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
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

    console.log("✅ feedback table ready");
  } catch (err) {
    console.error("❌ initDb error:", err);
  }
}

initDb();

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Te Ta Backend is running ✅");
});

// API key middleware
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

// POST /reservations -> insert into DB
app.post("/reservations", requireApiKey, async (req, res) => {
  try {
    const r = req.body;

    // Minimal required fields
    const required = ["customer_name", "phone", "date", "time", "people"];
    for (const f of required) {
      if (r[f] === undefined || r[f] === null || r[f] === "") {
        return res.status(400).json({ success: false, error: `Missing field: ${f}` });
      }
    }

    const reservation_id = r.reservation_id || crypto.randomUUID();

    const query = `
      INSERT INTO reservations (
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
        raw
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id, reservation_id, created_at;
    `;

    const values = [
      reservation_id,
      r.restaurant_name || "Te Ta Gastronomi",
      r.customer_name,
      r.phone,
      r.date,              // "2025-12-12"
      r.time,              // "20:00"
      Number(r.people),
      r.channel || null,
      r.area || null,
      r.first_time || null,
      r.allergies || null,
      r.special_requests || null,
      r                   // raw JSONB
    ];

    const result = await pool.query(query, values);

    return res.status(201).json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    console.error("❌ DB ERROR:", err);
    return res.status(500).json({ success: false, error: "DB insert failed" });
  }
});

// POST /feedback -> insert feedback into DB
app.post("/feedback", requireApiKey, async (req, res) => {
  try {
    const {
      restaurant_name = "Te Ta Gastronomi",
      phone,
      location_rating,
      hospitality_rating,
      food_rating,
      price_rating,
      comment = ""
    } = req.body;

    // Required
    if (!phone) {
      return res.status(400).json({ success: false, error: "Missing field: phone" });
    }

    const ratings = [location_rating, hospitality_rating, food_rating, price_rating];
    if (ratings.some(r => typeof r !== "number" || r < 1 || r > 5)) {
      return res.status(400).json({
        success: false,
        error: "Ratings must be numbers between 1 and 5"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO feedback
        (restaurant_name, phone, location_rating, hospitality_rating, food_rating, price_rating, comment)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, created_at;
      `,
      [
        restaurant_name,
        phone,
        location_rating,
        hospitality_rating,
        food_rating,
        price_rating,
        comment
      ]
    );

    return res.status(201).json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    console.error("❌ POST /feedback error:", err);
    return res.status(500).json({ success: false, error: "DB insert failed" });
  }
});

// GET /feedback -> list ALL feedback by default
// Optional filters:
//   ?limit=20
//   ?phone=069...
//   ?date=YYYY-MM-DD
//   ?min_avg=4
//   ?max_avg=3  (negative only, optional)
app.get("/feedback", requireApiKey, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const phone = req.query.phone ? String(req.query.phone).trim() : "";
    const date = req.query.date ? String(req.query.date).trim() : "";
    const minAvg = req.query.min_avg !== undefined ? Number(req.query.min_avg) : null;
    const maxAvg = req.query.max_avg !== undefined ? Number(req.query.max_avg) : null;

    const avgExpr = "(location_rating + hospitality_rating + food_rating + price_rating) / 4.0";

    const where = [];
    const params = [];
    let i = 1;

    if (phone) {
      where.push(`phone = $${i++}`);
      params.push(phone);
    }

    if (date) {
      where.push(`created_at::date = $${i++}::date`);
      params.push(date);
    }

    if (minAvg !== null && Number.isFinite(minAvg)) {
      where.push(`${avgExpr} >= $${i++}`);
      params.push(minAvg);
    }

    if (maxAvg !== null && Number.isFinite(maxAvg)) {
      where.push(`${avgExpr} <= $${i++}`);
      params.push(maxAvg);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const q = `
      SELECT
        id,
        restaurant_name,
        phone,
        location_rating,
        hospitality_rating,
        food_rating,
        price_rating,
        ${avgExpr} AS avg_rating,
        comment,
        created_at
      FROM feedback
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${i++};
    `;

    params.push(limit);

    const result = await pool.query(q, params);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    return res.status(500).json({ success: false, error: "DB read failed" });
  }
});

// Railway provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
