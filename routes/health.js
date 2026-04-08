const express = require("express");
const router = express.Router();
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const state = require("../lib/state");
const { requireApiKey } = require("../middleware/auth");
const { formatALDate } = require("../lib/time");

const MAX_AUTO_CONFIRM_PEOPLE = Number(process.env.MAX_AUTO_CONFIRM_PEOPLE || 6);

router.get("/", (req, res) => {
  res.status(200).send(`Te Ta Backend is running OK (${APP_VERSION})`);
});

// Railway / Load balancer healthcheck (NO AUTH, NO DB)
router.get("/health", (req, res) => {
  return res.json({ success: true, version: APP_VERSION, db_ready: !!state.DB_READY });
});

router.get("/health/db", requireApiKey, async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    state.DB_READY = true;
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
    state.DB_READY = false;
    return res.status(503).json({
      success: false,
      db: "down",
      version: APP_VERSION,
      error: err.message,
      restaurant_id: req.restaurant_id,
    });
  }
});

module.exports = router;
