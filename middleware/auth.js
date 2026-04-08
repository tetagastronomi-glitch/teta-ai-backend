const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { hashKey, safeEqual } = require("../lib/auth");

async function requireApiKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-api-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Missing x-api-key" });
    }

    const master = String(process.env.API_KEY || "").trim();
    if (master && safeEqual(rawKey, master)) {
      const rid = Number(process.env.RESTAURANT_ID || 0);
      req.restaurant_id = Number.isFinite(rid) && rid > 0 ? rid : null;
      return next();
    }

    const keyHash = hashKey(rawKey);
    const r = await pool.query(
      `SELECT restaurant_id FROM public.api_keys WHERE key_hash = $1 AND is_active = TRUE LIMIT 1;`,
      [keyHash]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Invalid api key" });
    }

    req.restaurant_id = Number(r.rows[0].restaurant_id);
    pool.query(`UPDATE public.api_keys SET last_used_at = NOW() WHERE key_hash = $1;`, [keyHash]).catch(() => {});
    return next();
  } catch (err) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Auth failed" });
  }
}

async function requireOwnerKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-owner-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Missing x-owner-key" });
    }

    const keyHash = hashKey(rawKey);
    const r = await pool.query(
      `SELECT restaurant_id FROM public.owner_keys WHERE key_hash = $1 AND is_active = TRUE LIMIT 1;`,
      [keyHash]
    );

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

async function requireAdminKey(req, res, next) {
  try {
    const rawKey = String(req.headers["x-admin-key"] || "").trim();
    if (!rawKey) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Missing x-admin-key" });
    }

    const expected = String(process.env.ADMIN_KEY || "").trim();
    if (!expected) {
      return res.status(503).json({
        success: false, version: APP_VERSION,
        error: "ADMIN endpoints disabled (ADMIN_KEY not configured)",
      });
    }

    if (!safeEqual(rawKey, expected)) {
      return res.status(401).json({ success: false, version: APP_VERSION, error: "Invalid admin key" });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Admin auth failed" });
  }
}

function requirePlan(requiredPlan) {
  return async (req, res, next) => {
    try {
      const q = await pool.query(
        `SELECT plan, trial_ends, plan_expires FROM public.restaurants WHERE id=$1 LIMIT 1;`,
        [req.restaurant_id]
      );
      const row = q.rows[0] || {};
      const now = new Date();

      let plan = String(row.plan || 'FREE').toUpperCase();
      if (row.trial_ends && new Date(row.trial_ends) >= now) plan = 'PRO';
      if (row.plan_expires && new Date(row.plan_expires) < now) plan = 'FREE';

      const need = String(requiredPlan || "FREE").toUpperCase();
      const rank = (p) => (p === "PRO" ? 2 : 1);
      if (rank(plan) < rank(need)) {
        return res.status(403).json({
          success: false, version: APP_VERSION, restaurant_id: req.restaurant_id,
          error: `Plan required: ${need}. Current: ${plan}`,
        });
      }

      req.plan = plan;
      next();
    } catch (err) {
      return res.status(500).json({
        success: false, version: APP_VERSION, restaurant_id: req.restaurant_id,
        error: "Plan check failed",
      });
    }
  };
}

module.exports = { requireApiKey, requireOwnerKey, requireAdminKey, requirePlan };
