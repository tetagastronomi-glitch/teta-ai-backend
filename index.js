const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

// Railway provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server listening on", PORT));
