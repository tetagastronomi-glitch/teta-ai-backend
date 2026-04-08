const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdminKey } = require("../middleware/auth");
const { requireDbReady } = require("../middleware/db");

// ==================== RFV CALCULATION ====================
async function calculateRFV(db, restaurantId) {
  const customers = await db.query(`
    SELECT
      phone,
      COUNT(*) as frequency,
      MAX(created_at) as last_visit,
      AVG(people) as avg_value,
      array_agg(status) as statuses
    FROM reservations
    WHERE restaurant_id = $1
      AND status IN ('confirmed', 'completed')
    GROUP BY phone
  `, [restaurantId]);

  const now = new Date();

  for (const c of customers.rows) {
    const daysSince = Math.floor((now - new Date(c.last_visit)) / (1000 * 60 * 60 * 24));
    const recency = daysSince <= 7  ? 10 :
                    daysSince <= 14 ? 8  :
                    daysSince <= 30 ? 6  :
                    daysSince <= 60 ? 3  : 1;
    const freq    = Math.min(c.frequency * 2, 10);
    const val     = Math.min(Math.floor(c.avg_value * 1.5), 10);
    const total   = recency + freq + val;
    const segment = total >= 24 ? 'vip'    :
                    total >= 16 ? 'active' :
                    total >= 10 ? 'warm'   : 'cold';

    await db.query(`
      INSERT INTO customer_scores
        (restaurant_id, phone, recency_score, frequency_score,
         value_score, rfv_total, segment, last_calculated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (restaurant_id, phone) DO UPDATE SET
        recency_score = $3, frequency_score = $4,
        value_score = $5, rfv_total = $6,
        segment = $7, last_calculated = NOW()
    `, [restaurantId, c.phone, recency, freq, val, total, segment]);
  }
}

// ==================== MARKETING ROUTES ====================
router.get('/admin/marketing/audience/:restaurantId', requireAdminKey, requireDbReady, async (req, res) => {
  const { restaurantId } = req.params;
  const { segment } = req.query;
  try {
    await calculateRFV(pool, restaurantId);

    let query = `
      SELECT
        cs.phone, cs.segment, cs.rfv_total,
        cs.recency_score, cs.frequency_score, cs.value_score,
        r.name as customer_name,
        COUNT(res.id) as total_visits,
        MAX(res.created_at) as last_visit,
        r.email
      FROM customer_scores cs
      LEFT JOIN reservations res ON cs.phone = res.phone AND res.restaurant_id = cs.restaurant_id
      LEFT JOIN reservations r ON cs.phone = r.phone AND r.restaurant_id = cs.restaurant_id
      WHERE cs.restaurant_id = $1
    `;
    const params = [restaurantId];
    if (segment && segment !== 'all') {
      query += ` AND cs.segment = $2`;
      params.push(segment);
    }
    query += ` GROUP BY cs.phone, cs.segment, cs.rfv_total,
      cs.recency_score, cs.frequency_score, cs.value_score, r.name, r.email
      ORDER BY cs.rfv_total DESC`;

    const result = await pool.query(query, params);

    const counts = await pool.query(
      `SELECT segment, COUNT(*) as count FROM customer_scores WHERE restaurant_id = $1 GROUP BY segment`,
      [restaurantId]
    );
    const segmentCounts = {};
    counts.rows.forEach(r => { segmentCounts[r.segment] = parseInt(r.count); });

    res.json({
      customers: result.rows,
      segments: {
        vip:    segmentCounts.vip    || 0,
        active: segmentCounts.active || 0,
        warm:   segmentCounts.warm   || 0,
        cold:   segmentCounts.cold   || 0,
        total:  result.rows.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/marketing/send', requireAdminKey, requireDbReady, async (req, res) => {
  const { restaurant_id, segment, channel, message, template_name } = req.body;
  try {
    const rest = await pool.query('SELECT * FROM restaurants WHERE id = $1', [restaurant_id]);
    if (!rest.rows[0] || rest.rows[0].plan !== 'pro') {
      return res.status(403).json({ error: 'Marketing disponohet vetëm për planin PRO' });
    }

    await calculateRFV(pool, restaurant_id);

    let custQuery = `
      SELECT DISTINCT cs.phone, r.name as customer_name, r.email
      FROM customer_scores cs
      LEFT JOIN reservations r ON cs.phone = r.phone AND cs.restaurant_id = r.restaurant_id
      WHERE cs.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (segment !== 'all') { custQuery += ` AND cs.segment = $2`; params.push(segment); }

    const customers = await pool.query(custQuery, params);
    let sent = 0, failed = 0;

    for (const customer of customers.rows) {
      try {
        if (channel === 'whatsapp' || channel === 'both') {
          const waRes = await fetch(
            `https://graph.facebook.com/v18.0/${process.env.WA_PHONE_ID}/messages`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.WA_PLATFORM_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: customer.phone.replace(/\D/g, ''),
                type: 'text',
                text: { body: message },
              }),
            }
          );
          if (waRes.ok) sent++; else failed++;
        }
        if ((channel === 'email' || channel === 'both') && customer.email && process.env.RESEND_API_KEY) {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Te Ta AI <noreply@tetaai.com>',
              to: customer.email,
              subject: rest.rows[0].name + ' — Mesazh special për ju',
              text: message,
            }),
          });
          if (emailRes.ok) sent++; else failed++;
        }
      } catch (_) { failed++; }
    }

    const campaign = await pool.query(`
      INSERT INTO marketing_campaigns
        (restaurant_id, segment, channel, message, template_name,
         recipients_count, sent_count, failed_count, triggered_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual') RETURNING *
    `, [restaurant_id, segment, channel, message, template_name, customers.rows.length, sent, failed]);

    res.json({ success: true, sent, failed, campaign_id: campaign.rows[0].id, recipients: customers.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/marketing/campaigns', requireAdminKey, requireDbReady, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT mc.*, r.name as restaurant_name
      FROM marketing_campaigns mc
      LEFT JOIN restaurants r ON mc.restaurant_id = r.id
      ORDER BY mc.created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/marketing/campaigns/:id/stats', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const campaign = await pool.query(
      `SELECT mc.*, r.name as restaurant_name FROM marketing_campaigns mc
       LEFT JOIN restaurants r ON mc.restaurant_id = r.id WHERE mc.id = $1`,
      [req.params.id]
    );
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Kampanja nuk u gjet' });

    const conversions = await pool.query(`
      SELECT COUNT(*) as count FROM reservations
      WHERE restaurant_id = $1
        AND created_at > $2
        AND created_at < $2::timestamp + INTERVAL '30 days'
        AND status IN ('confirmed', 'completed')
    `, [campaign.rows[0].restaurant_id, campaign.rows[0].created_at]);

    res.json({
      ...campaign.rows[0],
      conversions: parseInt(conversions.rows[0].count),
      conversion_rate: campaign.rows[0].sent_count > 0
        ? Math.round(conversions.rows[0].count / campaign.rows[0].sent_count * 100)
        : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/marketing/triggers', requireAdminKey, requireDbReady, async (req, res) => {
  const { restaurant_id, trigger_type, segment, channel, message_template } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO marketing_triggers (restaurant_id, trigger_type, segment, channel, message_template)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [restaurant_id, trigger_type, segment, channel, message_template]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/marketing/triggers/:restaurantId', requireAdminKey, requireDbReady, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM marketing_triggers WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [req.params.restaurantId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
