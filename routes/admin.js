const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { requireAdminKey } = require("../middleware/auth");
const { requireDbReady } = require("../middleware/db");
const { hashKey, genApiKey, genOwnerKey } = require("../lib/auth");
const { getTodayAL, getNowHHMI_AL, subtractMinutesHHMI } = require("../lib/time");

// ==================== ADMIN (PLATFORM OWNER) ====================
router.get("/admin/debug-env", requireAdminKey, (req, res) => {
  const safe = (x) => (x ? String(x).slice(0, 4) + "***" : "");
  return res.json({
    success: true,
    version: APP_VERSION,
    node_env: process.env.NODE_ENV || "",
    has_db_url: !!process.env.DATABASE_URL,
    has_admin_key: !!process.env.ADMIN_KEY,
    has_make_webhook: !!process.env.MAKE_ALERTS_WEBHOOK_URL,
    public_base_url: process.env.PUBLIC_BASE_URL || "",
    api_key_masked: safe(process.env.API_KEY),
    restaurant_id_env: process.env.RESTAURANT_ID || "",
    has_wa_token: !!process.env.WA_TOKEN,
    has_wa_phone_id: !!process.env.WA_PHONE_NUMBER_ID,
  });
});

// GET /admin/stats
router.get("/admin/stats", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const [rests, active, resTotal, resToday, uniCusts, missed, byStatus] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM public.restaurants`),
      pool.query(`SELECT COUNT(*) AS cnt FROM public.restaurants WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) AS cnt FROM public.reservations`),
      pool.query(`SELECT COUNT(*) AS cnt FROM public.reservations WHERE date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date`),
      pool.query(`SELECT COUNT(DISTINCT phone) AS cnt FROM public.reservations`),
      pool.query(`SELECT COUNT(*) AS cnt FROM public.missed_messages`),
      pool.query(`SELECT status, COUNT(*) AS cnt FROM public.reservations GROUP BY status ORDER BY cnt DESC`),
    ]);
    return res.json({
      success: true, version: APP_VERSION,
      data: {
        total_restaurants:       Number(rests.rows[0].cnt),
        active_restaurants:      Number(active.rows[0].cnt),
        reservations_today:      Number(resToday.rows[0].cnt),
        reservations_total:      Number(resTotal.rows[0].cnt),
        unique_customers_total:  Number(uniCusts.rows[0].cnt),
        missed_messages_total:   Number(missed.rows[0].cnt),
        reservations_by_status:  byStatus.rows,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants
router.get("/admin/restaurants", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT
        r.id, r.name, r.owner_phone, r.plan, r.is_active,
        r.opening_hours_start, r.opening_hours_end,
        r.max_capacity, r.max_auto_confirm_people, r.same_day_cutoff_hhmi,
        r.trial_ends, r.plan_expires,
        r.created_at,
        COUNT(DISTINCT res.id)    AS reservation_count,
        COUNT(DISTINCT res.phone) AS unique_customers
      FROM public.restaurants r
      LEFT JOIN public.reservations res ON res.restaurant_id = r.id
      GROUP BY r.id
      ORDER BY r.id ASC
    `);
    return res.json({ success: true, version: APP_VERSION, count: q.rows.length, data: q.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants/:id
router.get("/admin/restaurants/:id", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });

    const r = await pool.query(`SELECT * FROM public.restaurants WHERE id = $1`, [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Not found" });

    const [stats, apiKeys, ownerKeys] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                   AS reservation_count,
          COUNT(DISTINCT phone)                      AS unique_customers,
          MAX(created_at)                            AS last_reservation_at,
          COUNT(*) FILTER (WHERE status='Confirmed') AS confirmed,
          COUNT(*) FILTER (WHERE status='Pending')   AS pending,
          COUNT(*) FILTER (WHERE status='Completed') AS completed,
          COUNT(*) FILTER (WHERE status='Cancelled') AS cancelled,
          COUNT(*) FILTER (WHERE status='NoShow')    AS noshow
        FROM public.reservations WHERE restaurant_id = $1`, [id]),
      pool.query(`SELECT id, label, is_active, created_at, last_used_at FROM public.api_keys   WHERE restaurant_id=$1 AND is_active=TRUE ORDER BY id DESC`, [id]),
      pool.query(`SELECT id, label, is_active, created_at, last_used_at FROM public.owner_keys WHERE restaurant_id=$1 AND is_active=TRUE ORDER BY id DESC`, [id]),
    ]);

    const s = stats.rows[0];
    return res.json({
      success: true, version: APP_VERSION,
      data: {
        ...r.rows[0],
        reservation_count:    Number(s.reservation_count),
        unique_customers:     Number(s.unique_customers),
        last_reservation_at:  s.last_reservation_at || null,
        reservations_by_status: {
          confirmed: Number(s.confirmed), pending: Number(s.pending),
          completed: Number(s.completed), cancelled: Number(s.cancelled), noshow: Number(s.noshow),
        },
        api_keys:   apiKeys.rows,
        owner_keys: ownerKeys.rows,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /admin/restaurants/:id/settings — partial update
router.patch("/admin/restaurants/:id/settings", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });

    const b = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;

    const addField = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

    if (b.name        !== undefined) addField('name',                b.name);
    if (b.is_active   !== undefined) addField('is_active',           b.is_active === true || b.is_active === 'true' || b.is_active === 1);
    if (b.plan        !== undefined) addField('plan',                String(b.plan).toLowerCase());
    if (b.max_capacity!== undefined) addField('max_capacity',        Number(b.max_capacity));
    if (b.opening_time!== undefined) addField('opening_hours_start', b.opening_time);
    if (b.closing_time!== undefined) addField('opening_hours_end',   b.closing_time);
    if (b.opening_hours_start !== undefined) addField('opening_hours_start', b.opening_hours_start);
    if (b.opening_hours_end   !== undefined) addField('opening_hours_end',   b.opening_hours_end);
    if (b.owner_phone !== undefined) addField('owner_phone', b.owner_phone);
    if (b.max_auto_confirm_people !== undefined) addField('max_auto_confirm_people', Number(b.max_auto_confirm_people));
    if (b.same_day_cutoff_hhmi    !== undefined) addField('same_day_cutoff_hhmi',    b.same_day_cutoff_hhmi);

    if (!sets.length) return res.status(400).json({ success: false, error: "No fields to update" });

    vals.push(id);
    const q = await pool.query(
      `UPDATE public.restaurants SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!q.rows.length) return res.status(404).json({ success: false, error: "Not found" });
    return res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /admin/restaurants — create new restaurant
router.post("/admin/restaurants", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ success: false, error: "Missing field: name" });

    const owner_phone  = String(b.owner_phone  || "").trim();
    const plan         = String(b.plan         || "free").toLowerCase();
    const max_capacity = Number(b.max_capacity || 50);

    // Auto-generate unique 4-digit PIN
    let pinCode;
    let pinExists = true;
    while (pinExists) {
      pinCode = String(Math.floor(1000 + Math.random() * 9000));
      const check = await pool.query('SELECT id FROM public.restaurants WHERE pin_code = $1', [pinCode]);
      pinExists = check.rows.length > 0;
    }

    const r = await pool.query(
      `INSERT INTO public.restaurants (name, owner_phone, plan, max_capacity, is_active, trial_ends, pin_code)
       VALUES ($1,$2,$3,$4,true, CURRENT_DATE + INTERVAL '14 days', $5)
       RETURNING id, name, owner_phone, plan, max_capacity, is_active, trial_ends, pin_code, created_at`,
      [name, owner_phone, plan, max_capacity, pinCode]
    );
    const restaurant = r.rows[0];

    // Keys: tta_ prefix for API, own_ for owner
    const api_key   = 'tta_' + crypto.randomBytes(16).toString('hex');
    const owner_key = 'own_' + crypto.randomBytes(8).toString('hex');

    await pool.query(
      `INSERT INTO public.api_keys   (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,'auto-created',TRUE)`,
      [restaurant.id, hashKey(api_key)]
    );
    await pool.query(
      `INSERT INTO public.owner_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,'auto-created',TRUE)`,
      [restaurant.id, hashKey(owner_key)]
    );

    console.log(`✅ Admin created restaurant #${restaurant.id}: ${name} (PIN: ${pinCode})`);
    return res.status(201).json({
      success: true, version: APP_VERSION,
      data: { restaurant, api_key, owner_key, pin_code: pinCode, note: "Ruaji këto keys dhe PIN-in tani — shfaqen vetëm 1 herë." }
    });
  } catch (err) {
    console.error("❌ POST /admin/restaurants:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/env-check
router.get("/admin/env-check", requireAdminKey, (req, res) => {
  return res.json({
    success: true, version: APP_VERSION,
    data: {
      DATABASE_URL:        !!process.env.DATABASE_URL,
      ANTHROPIC_API_KEY:   !!process.env.ANTHROPIC_API_KEY,
      ADMIN_KEY:           !!process.env.ADMIN_KEY,
      RESEND_API_KEY:      !!process.env.RESEND_API_KEY,
      WA_PLATFORM_TOKEN:   !!process.env.WA_PLATFORM_TOKEN,
      WA_PHONE_ID:         !!process.env.WA_PHONE_ID,
      WA_BUSINESS_ID:      !!process.env.WA_BUSINESS_ID,
    }
  });
});

router.post("/admin/restaurants/:id/plan", requireAdminKey, requireDbReady, async (req, res) => {
  const id = Number(req.params.id);
  const plan = String(req.body?.plan || "").trim().toUpperCase();

  if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
  if (!["FREE", "PRO"].includes(plan)) {
    return res.status(400).json({ success: false, version: APP_VERSION, error: "plan must be FREE or PRO" });
  }

  const q = await pool.query(`UPDATE public.restaurants SET plan=$1 WHERE id=$2 RETURNING id,name,owner_phone,plan,trial_ends,plan_expires;`, [
    plan, id,
  ]);
  if (q.rows.length === 0) return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });

  res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
});

// PATCH /admin/restaurants/:id/billing — set plan_expires after manual payment
router.patch("/admin/restaurants/:id/billing", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });

    const { plan_expires, plan } = req.body || {};
    if (!plan_expires) return res.status(400).json({ success: false, error: "Missing field: plan_expires (YYYY-MM-DD)" });

    const newPlan = plan ? String(plan).toLowerCase() : 'pro';
    const q = await pool.query(
      `UPDATE public.restaurants SET plan=$1, plan_expires=$2 WHERE id=$3
       RETURNING id, name, owner_phone, plan, trial_ends, plan_expires`,
      [newPlan, plan_expires, id]
    );
    if (!q.rows.length) return res.status(404).json({ success: false, error: "Not found" });

    console.log(`✅ Billing updated for restaurant #${id}: plan=${newPlan}, expires=${plan_expires}`);
    res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/restaurants/:id — cascade delete
router.delete("/admin/restaurants/:id", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });
    await pool.query(`DELETE FROM public.reservations WHERE restaurant_id = $1`, [id]);
    await pool.query(`DELETE FROM public.customers WHERE restaurant_id = $1`, [id]);
    await pool.query(`DELETE FROM public.feedback WHERE restaurant_id = $1`, [id]);
    await pool.query(`DELETE FROM public.api_keys WHERE restaurant_id = $1`, [id]);
    await pool.query(`DELETE FROM public.owner_keys WHERE restaurant_id = $1`, [id]);
    const r = await pool.query(`DELETE FROM public.restaurants WHERE id = $1 RETURNING id, name`, [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "Not found" });
    console.log(`✅ Admin deleted restaurant #${id}: ${r.rows[0].name}`);
    res.json({ success: true, message: 'Restorant u fshi', deleted: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants/:id/reservations
router.get("/admin/restaurants/:id/reservations", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });
    const q = await pool.query(
      `SELECT * FROM public.reservations WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [id]
    );
    res.json({ success: true, count: q.rows.length, data: q.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants/:id/customers
router.get("/admin/restaurants/:id/customers", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });
    const q = await pool.query(
      `SELECT * FROM public.customers WHERE restaurant_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 500`,
      [id]
    );
    res.json({ success: true, count: q.rows.length, data: q.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants/:id/feedback
router.get("/admin/restaurants/:id/feedback", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });
    const q = await pool.query(
      `SELECT * FROM public.feedback WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [id]
    );
    res.json({ success: true, count: q.rows.length, data: q.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /admin/restaurants/:id/stats
router.get("/admin/restaurants/:id/stats", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: "Invalid id" });
    const [week, dayPeak, hourPeak, customers] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS this_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days'
                             AND created_at <  NOW() - INTERVAL '7 days')  AS last_week
        FROM public.reservations WHERE restaurant_id = $1`, [id]),
      pool.query(`
        SELECT TO_CHAR(date::date,'Day') AS day_name, COUNT(*) AS cnt
        FROM public.reservations WHERE restaurant_id=$1 AND date IS NOT NULL
        GROUP BY day_name ORDER BY cnt DESC LIMIT 1`, [id]),
      pool.query(`
        SELECT SPLIT_PART(time,':',1) AS hour, COUNT(*) AS cnt
        FROM public.reservations WHERE restaurant_id=$1 AND time IS NOT NULL
        GROUP BY hour ORDER BY cnt DESC LIMIT 1`, [id]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE visits_count=1) AS new_customers,
          COUNT(*) FILTER (WHERE visits_count>1)  AS returning_customers
        FROM public.customers WHERE restaurant_id=$1`, [id]),
    ]);
    res.json({ success: true, data: {
      this_week:           Number(week.rows[0]?.this_week || 0),
      last_week:           Number(week.rows[0]?.last_week || 0),
      peak_day:            dayPeak.rows[0]?.day_name?.trim() || '—',
      peak_hour:           hourPeak.rows[0] ? hourPeak.rows[0].hour + ':00' : '—',
      new_customers:       Number(customers.rows[0]?.new_customers || 0),
      returning_customers: Number(customers.rows[0]?.returning_customers || 0),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /admin/cleanup-duplicates
router.delete("/admin/cleanup-duplicates", requireAdminKey, requireDbReady, async (_req, res) => {
  try {
    const result = await pool.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY phone, date, time, restaurant_id ORDER BY id ASC
        ) AS rn
        FROM public.reservations
      )
      DELETE FROM public.reservations WHERE id IN (
        SELECT id FROM ranked WHERE rn > 1
      ) RETURNING id
    `);
    const rem = await pool.query(`SELECT COUNT(*) AS cnt FROM public.reservations`);
    res.json({ success: true, deleted: result.rows.length, remaining: Number(rem.rows[0].cnt) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// CRON: AUTO CLOSE RESERVATIONS
router.post("/cron/auto-close", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const today = await getTodayAL();
    const nowHHMI = await getNowHHMI_AL();

    const bufferMinutes = 120;
    const cutoffHHMI = subtractMinutesHHMI(nowHHMI, bufferMinutes);

    const q = await pool.query(
      `
      SELECT id, restaurant_id, reservation_id, status, date, time, phone, customer_name
      FROM public.reservations
      WHERE
        status IN ('Confirmed','Pending')
        AND (
          (date::date < $1::date)
          OR (
            date::date = $1::date
            AND NULLIF(time::text,'')::time <= $2::time
          )
        )
      ORDER BY date ASC, time ASC
      LIMIT 500;
      `,
      [today, cutoffHHMI]
    );

    let completed = 0;
    let noshow = 0;

    for (const r of q.rows) {
      const finalStatus = r.status === "Confirmed" ? "Completed" : "NoShow";

      const up = await pool.query(
        `
        UPDATE public.reservations
        SET status=$3, closed_at=NOW(), closed_reason='auto_close_cron'
        WHERE id=$1 AND restaurant_id=$2 AND status=$4
        RETURNING id;
        `,
        [r.id, r.restaurant_id, finalStatus, r.status]
      );

      if (up.rows.length) {
        if (finalStatus === "Completed") completed++;
        else noshow++;

        pool.query(
          `UPDATE public.events SET status=$3 WHERE restaurant_id=$1 AND reservation_id=$2;`,
          [r.restaurant_id, r.reservation_id, finalStatus]
        ).catch(() => {});
      }
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      message: "Auto-close done",
      data: { scanned: q.rows.length, completed, noshow, today, nowHHMI, cutoffHHMI }
    });
  } catch (e) {
    console.error("❌ /cron/auto-close error:", e);
    return res.status(500).json({
      success: false,
      version: APP_VERSION,
      error: "Auto-close failed"
    });
  }
});

// Admin: update feedback settings
router.post("/admin/restaurants/:id/feedback-settings", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    const enabled =
      req.body?.feedback_enabled === undefined ? null : String(req.body.feedback_enabled).trim().toLowerCase();
    const feedback_enabled =
      enabled === null
        ? null
        : ["true", "1", "yes", "po", "ok"].includes(enabled)
        ? true
        : ["false", "0", "no", "jo"].includes(enabled)
        ? false
        : null;

    const feedback_cooldown_days =
      req.body?.feedback_cooldown_days === undefined ? null : Number(req.body.feedback_cooldown_days);
    const feedback_batch_limit = req.body?.feedback_batch_limit === undefined ? null : Number(req.body.feedback_batch_limit);
    const feedback_exclude_frequent_over_visits =
      req.body?.feedback_exclude_frequent_over_visits === undefined
        ? null
        : Number(req.body.feedback_exclude_frequent_over_visits);

    const feedback_template = req.body?.feedback_template === undefined ? null : String(req.body.feedback_template || "");

    const q = await pool.query(
      `
      UPDATE public.restaurants
      SET
        feedback_enabled = COALESCE($1, feedback_enabled),
        feedback_cooldown_days = COALESCE($2, feedback_cooldown_days),
        feedback_batch_limit = COALESCE($3, feedback_batch_limit),
        feedback_exclude_frequent_over_visits = COALESCE($4, feedback_exclude_frequent_over_visits),
        feedback_template = COALESCE($5, feedback_template)
      WHERE id=$6
      RETURNING id, name, feedback_enabled, feedback_cooldown_days, feedback_batch_limit, feedback_exclude_frequent_over_visits, feedback_template;
      `,
      [feedback_enabled, feedback_cooldown_days, feedback_batch_limit, feedback_exclude_frequent_over_visits, feedback_template, id]
    );

    if (!q.rows.length) return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });
    return res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /admin/restaurants/:id/feedback-settings error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.post("/admin/keys/disable", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const type = String(req.body?.type || "").trim().toLowerCase();
    const rawKey = String(req.body?.key || "").trim();
    if (!["api", "owner"].includes(type)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "type must be api or owner" });
    }
    if (!rawKey) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing key" });
    }

    const keyHash = hashKey(rawKey);
    const table = type === "api" ? "public.api_keys" : "public.owner_keys";

    const q = await pool.query(
      `UPDATE ${table} SET is_active=FALSE WHERE key_hash=$1 RETURNING id, restaurant_id, label, is_active;`,
      [keyHash]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Key not found" });
    }

    res.json({ success: true, version: APP_VERSION, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /admin/keys/disable error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.post("/admin/restaurants/:id/rotate-keys", requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });

    await pool.query(`UPDATE public.api_keys SET is_active=FALSE WHERE restaurant_id=$1;`, [id]);
    await pool.query(`UPDATE public.owner_keys SET is_active=FALSE WHERE restaurant_id=$1;`, [id]);

    const api_key = genApiKey();
    const owner_key = genOwnerKey();

    const api_hash = hashKey(api_key);
    const owner_hash = hashKey(owner_key);

    await pool.query(
      `INSERT INTO public.api_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [id, api_hash, "rotated"]
    );
    await pool.query(
      `INSERT INTO public.owner_keys (restaurant_id, key_hash, label, is_active) VALUES ($1,$2,$3,TRUE);`,
      [id, owner_hash, "rotated"]
    );

    res.json({
      success: true,
      version: APP_VERSION,
      data: {
        restaurant_id: id,
        api_key,
        owner_key,
        note: "Ruaji këto keys tani. Në DB ruhet vetëm hash; s'mund t'i shohësh raw më vonë.",
      },
    });
  } catch (err) {
    console.error("❌ POST /admin/restaurants/:id/rotate-keys error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// POST /admin/jerry/chat
router.post('/admin/jerry/chat', requireAdminKey, requireDbReady, async (req, res) => {
  const { message, history } = req.body;
  try {
    const [statsRes, resRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(DISTINCT id) as total_restaurants,
          COUNT(DISTINCT CASE WHEN is_active THEN id END) as active_restaurants
        FROM restaurants`),
      pool.query(`
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN DATE(created_at AT TIME ZONE 'Europe/Tirane') =
            CURRENT_DATE AT TIME ZONE 'Europe/Tirane' THEN 1 END) as today
        FROM reservations`),
    ]);

    const context = `Ti je Jerry — agjenti inteligjent i Te Ta AI, platformë rezervimesh për restorante shqiptare.
Të dhënat live:
- Restorantet: ${statsRes.rows[0].total_restaurants} (${statsRes.rows[0].active_restaurants} aktive)
- Rezervime sot: ${resRes.rows[0].today}
- Total rezervime: ${resRes.rows[0].total}
Përgjigju në shqip, drejtpërdrejt si partner biznesi. Ji i shkurtër dhe preciz.`;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: context,
      messages: [...(history || []), { role: 'user', content: message }],
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reservations
router.get('/admin/reservations', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const result = await pool.query(`
      SELECT r.*, res.name as restaurant_name
      FROM reservations r
      LEFT JOIN restaurants res ON r.restaurant_id = res.id
      ORDER BY r.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/restaurants/:id/customers — add customer from Command Center
router.post('/admin/restaurants/:id/customers', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const restaurantId = Number(req.params.id);
    const { name, phone } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: 'Emri dhe telefoni janë të detyrueshëm' });
    const existing = await pool.query(
      'SELECT id FROM public.customers WHERE phone=$1 AND restaurant_id=$2',
      [phone, restaurantId]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Ky klient ekziston tashmë' });
    const r = await pool.query(
      `INSERT INTO public.customers (restaurant_id, phone, full_name, first_seen_at, last_seen_at, visits_count, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW(),0,NOW(),NOW()) RETURNING *`,
      [restaurantId, phone, name]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/support-tickets
router.get('/admin/support-tickets', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const q = status === 'all'
      ? await pool.query('SELECT * FROM public.support_tickets ORDER BY created_at DESC')
      : await pool.query('SELECT * FROM public.support_tickets WHERE status=$1 ORDER BY created_at DESC', [status]);
    res.json({ success: true, count: q.rows.length, data: q.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /admin/support-tickets/:id
router.put('/admin/support-tickets/:id', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const { status, admin_notes } = req.body || {};
    await pool.query(
      'UPDATE public.support_tickets SET status=$1, admin_notes=$2, resolved_at=NOW() WHERE id=$3',
      [status || 'resolved', admin_notes || '', Number(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
