const express = require("express");
const router = express.Router();
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { requireApiKey } = require("../middleware/auth");
const { requireDbReady, requireNotProduction } = require("../middleware/db");

router.get("/debug/customers", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
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

router.get("/debug/reservations-schema", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
  const q = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reservations'
    ORDER BY ordinal_position;
  `);
  return res.json({ success: true, version: APP_VERSION, columns: q.rows });
});

router.get("/debug/reservations-constraints", requireNotProduction, requireApiKey, requireDbReady, async (req, res) => {
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

module.exports = router;
