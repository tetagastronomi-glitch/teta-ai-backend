const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db");
const { hashKey, safeEqual } = require("../lib/auth");
const { requireDbReady } = require("../middleware/db");
const { loginLimiter } = require("../middleware/security");

// POST /auth/login
router.post('/auth/login', loginLimiter, async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Kodi mungon' });

  // FIX: use safeEqual instead of insecure === comparison
  if (safeEqual(key, process.env.ADMIN_KEY)) {
    return res.json({ role: 'admin', redirect: '/command' });
  }

  try {
    const keyHash = hashKey(key);
    const result = await pool.query(
      `SELECT r.id, r.name FROM public.owner_keys ok
       JOIN public.restaurants r ON r.id = ok.restaurant_id
       WHERE ok.key_hash = $1 AND ok.is_active = TRUE LIMIT 1`,
      [keyHash]
    );
    if (result.rows.length > 0) {
      return res.json({
        role: 'owner',
        redirect: '/dashboard',
        restaurant_id: result.rows[0].id,
        restaurant_name: result.rows[0].name,
      });
    }
  } catch (err) {
    console.error('Auth error:', err.message);
  }

  return res.status(401).json({ error: 'Kodi nuk ekziston' });
});

// PIN login for restaurant owners
router.post('/auth/pin-login', loginLimiter, requireDbReady, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'Kodi mungon' });
  try {
    // Query restaurant directly by pin_code — no JOIN needed
    const result = await pool.query(
      `SELECT id, name FROM public.restaurants WHERE pin_code = $1 AND is_active = TRUE LIMIT 1`,
      [String(pin).trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Kodi nuk është i saktë' });
    }
    const row = result.rows[0];
    // Generate fresh owner_key, deactivate old pin-login keys, insert new one
    const owner_key = 'own_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `UPDATE public.owner_keys SET is_active=FALSE WHERE restaurant_id=$1 AND label='pin-login'`,
      [row.id]
    );
    await pool.query(
      `INSERT INTO public.owner_keys (restaurant_id, key_hash, label, is_active)
       VALUES ($1,$2,'pin-login',TRUE)`,
      [row.id, hashKey(owner_key)]
    );
    return res.json({ success: true, owner_key, restaurant_id: row.id, restaurant_name: row.name });
  } catch (err) {
    console.error('PIN login error:', err.message);
    res.status(500).json({ error: 'Gabim serveri' });
  }
});

module.exports = router;
