const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { requireOwnerKey } = require("../middleware/auth");
const { requireDbReady } = require("../middleware/db");
const { formatALDate, getTodayAL, normalizeTimeHHMI, toYMD } = require("../lib/time");
const { fireMakeEvent, fireFeedbackRequest } = require("../lib/notifications");
const { getRestaurantRules, decideReservationStatus } = require("../lib/status");
const { validate, customerSchema, ownerReservationSchema } = require("../middleware/validate");

// ==================== HELPERS ====================
function mapFinalStatus(action) {
  if (action === "complete") return "Completed";
  if (action === "no-show") return "NoShow";
  if (action === "cancel") return "Cancelled";
  return null;
}

async function closeReservationByOwner({ restaurant_id, reservationPkId, action }) {
  const finalStatus = mapFinalStatus(action);
  if (!finalStatus) return { ok: false, code: 400, error: "Invalid action" };

  const beforeQ = await pool.query(
    `
    SELECT id, reservation_id, status, date, time, phone, customer_name, restaurant_name, people, channel, area, created_at
    FROM public.reservations
    WHERE id=$1 AND restaurant_id=$2
    LIMIT 1;
    `,
    [reservationPkId, restaurant_id]
  );
  if (!beforeQ.rows.length) return { ok: false, code: 404, error: "Reservation not found" };

  const r = beforeQ.rows[0];
  const statusBefore = String(r.status || "");

  const finals = new Set(["Completed", "NoShow", "Cancelled"]);
  if (finals.has(statusBefore)) {
    return { ok: false, code: 409, error: `Already closed (${statusBefore})`, data: r };
  }

  if (action === "complete" && statusBefore !== "Confirmed") {
    return { ok: false, code: 409, error: "Can complete only Confirmed reservations", data: r };
  }
  if (action === "cancel" && !(statusBefore === "Pending" || statusBefore === "Confirmed")) {
    return { ok: false, code: 409, error: "Can cancel only Pending/Confirmed reservations", data: r };
  }
  if (action === "no-show" && !(statusBefore === "Pending" || statusBefore === "Confirmed")) {
    return { ok: false, code: 409, error: "Can mark no-show only Pending/Confirmed reservations", data: r };
  }

  // Atomic update with optimistic lock on previous status
  const up = await pool.query(
    `
    UPDATE public.reservations
    SET status=$3, closed_at=NOW(), closed_reason=$4
    WHERE id=$1 AND restaurant_id=$2 AND status=$5
    RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at, closed_at, closed_reason;
    `,
    [reservationPkId, restaurant_id, finalStatus, `owner_${action}`, statusBefore]
  );

  if (!up.rows.length) return { ok: false, code: 409, error: "State changed, try again" };

  const row = up.rows[0];

  // Sync events (best-effort)
  pool
    .query(`UPDATE public.events SET status=$3 WHERE restaurant_id=$1 AND reservation_id=$2;`, [
      restaurant_id,
      row.reservation_id,
      finalStatus,
    ])
    .catch(() => {});

  // Update customer stats ONLY on Completed (best-effort)
  if (finalStatus === "Completed") {
    const ymd = String(row.date).slice(0, 10);
    const hhmi = String(row.time || "").trim().slice(0, 5); // "HH:MI"

    pool
      .query(
        `
        INSERT INTO public.customers (restaurant_id, phone, full_name, first_seen_at, last_seen_at, visits_count)
        VALUES (
          $1,
          $2,
          $3,
          ((($4::date + $5::time) AT TIME ZONE 'Europe/Tirane')),
          ((($4::date + $5::time) AT TIME ZONE 'Europe/Tirane')),
          1
        )
        ON CONFLICT (restaurant_id, phone) DO UPDATE
        SET
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.customers.full_name),
          last_seen_at = GREATEST(public.customers.last_seen_at, EXCLUDED.last_seen_at),
          visits_count = public.customers.visits_count + 1,
          updated_at = NOW();
        `,
        [restaurant_id, row.phone, row.customer_name, ymd, hhmi]
      )
      .catch(() => {});
  }

  return { ok: true, status_before: statusBefore, status_after: finalStatus, row };
}

// Audit logger
function logOwnerDecision(req, action, meta = {}) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || req.ip;

  console.log("OWNER_DECISION", {
    action,
    actor: meta.actor || "owner_key",
    token: meta.token || null,
    id: meta.id || null,
    reservation_id: meta.reservation_id || null,
    restaurant_id: meta.restaurant_id || req.restaurant_id || null,
    status_before: meta.status_before || null,
    status_after: meta.status_after || null,
    ip,
    ua: req.headers["user-agent"] || null,
    referer: req.headers["referer"] || null,
    ts: new Date().toISOString(),
  });
}

async function getFeedbackSettings(restaurantId) {
  const st = await pool.query(
    `
    SELECT
      feedback_enabled,
      feedback_cooldown_days,
      feedback_batch_limit,
      feedback_exclude_frequent_over_visits,
      feedback_template
    FROM public.restaurants
    WHERE id=$1
    LIMIT 1;
    `,
    [restaurantId]
  );
  return st.rows[0] || {
    feedback_enabled: true,
    feedback_cooldown_days: 10,
    feedback_batch_limit: 30,
    feedback_exclude_frequent_over_visits: 5,
    feedback_template: "",
  };
}

// ==================== OWNER VIEW ====================
router.get("/owner/customers", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    const result = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        phone,
        full_name,
        visits_count,
        first_seen_at,
        last_seen_at,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        feedback_last_sent_at,
        feedback_last_received_at,
        created_at,
        updated_at
      FROM public.customers
      WHERE restaurant_id = $1
        AND (last_seen_at IS NULL OR last_seen_at <= NOW())
      ORDER BY last_seen_at DESC NULLS LAST, visits_count DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: result.rows,
    });
  } catch (err) {
    console.error("❌ GET /owner/customers error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// POST /owner/customers — add customer from owner dashboard
router.post('/owner/customers', requireOwnerKey, requireDbReady, validate(customerSchema), async (req, res) => {
  try {
    const { name, phone } = req.validated;
    const existing = await pool.query(
      'SELECT id FROM public.customers WHERE phone=$1 AND restaurant_id=$2',
      [phone, req.restaurant_id]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Ky klient ekziston tashmë' });
    const r = await pool.query(
      `INSERT INTO public.customers (restaurant_id, phone, full_name, first_seen_at, last_seen_at, visits_count, created_at, updated_at)
       VALUES ($1,$2,$3,NOW(),NOW(),0,NOW(),NOW()) RETURNING *`,
      [req.restaurant_id, phone, name]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== OWNER: CREATE RESERVATION MANUALLY =====
router.post("/owner/reservations/create", requireOwnerKey, requireDbReady, validate(ownerReservationSchema), async (req, res) => {
  try {
    const r = req.body || {};

    const dateStr  = r.date  || await getTodayAL();
    const timeStr  = normalizeTimeHHMI(r.time || "00:00") || "00:00";
    const people   = Number(r.people) > 0 ? Number(r.people) : 2;
    const channel  = r.channel  || "telefon";
    const area     = r.area     || null;
    const special  = r.special_requests || "";

    // Opening hours + capacity validation
    const rules = await getRestaurantRules(req.restaurant_id);
    if (timeStr !== "00:00" && (timeStr < rules.openingStart || timeStr >= rules.openingEnd)) {
      return res.status(400).json({
        success: false, version: APP_VERSION, error_code: "OPENING_HOURS",
        error: `Restoranti është i hapur ${rules.openingStart}–${rules.openingEnd}. Ju lutemi zgjidhni një orë brenda orarit të punës.`,
      });
    }
    const capacityRow = await pool.query(
      `SELECT COUNT(*) AS cnt FROM public.reservations
       WHERE restaurant_id=$1 AND date=$2::date AND time=$3
         AND status IN ('Confirmed','Pending')`,
      [req.restaurant_id, dateStr, timeStr]
    );
    if (Number(capacityRow.rows[0].cnt) >= rules.maxCapacity) {
      return res.status(409).json({
        success: false, version: APP_VERSION, error_code: "CAPACITY_FULL",
        error: `Nuk ka vende të lira për orën ${timeStr}. Ju lutemi zgjidhni një orë tjetër.`,
      });
    }

    const decision = await decideReservationStatus(req.restaurant_id, dateStr, people);
    const status   = decision.status;
    const reservation_id = crypto.randomUUID();

    const result = await pool.query(
      `INSERT INTO public.reservations
        (restaurant_id, reservation_id, restaurant_name, customer_name, phone, date, time, people, channel, area, special_requests, raw, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, reservation_id, created_at, status`,
      [
        req.restaurant_id, reservation_id, r.restaurant_name || "Te Ta Gastronomi",
        r.customer_name, r.phone, dateStr, timeStr, people,
        channel, area, special, r, status,
      ]
    );

    const inserted = result.rows[0];

    // Sync to customers (non-blocking)
    pool.query(
      `INSERT INTO public.customers (restaurant_id, phone, full_name, first_seen_at, created_at, updated_at)
       VALUES ($1,$2,NULLIF($3,''),NOW(),NOW(),NOW())
       ON CONFLICT (restaurant_id, phone)
       DO UPDATE SET full_name=COALESCE(NULLIF(EXCLUDED.full_name,''),public.customers.full_name), updated_at=NOW()`,
      [req.restaurant_id, r.phone, r.customer_name]
    ).catch(e => console.error("⚠️ customer sync failed:", e.message));

    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      data: { ...inserted, created_at_local: formatALDate(inserted.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /owner/reservations/create error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.get("/owner/reservations", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const result = await pool.query(
      `
      SELECT
        id,
        restaurant_id,
        reservation_id,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        allergies,
        special_requests,
        status,
        feedback_requested_at,
        feedback_received_at,
        created_at
      FROM public.reservations
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /owner/reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== COMPLETE / NO-SHOW / CANCEL ====================
router.post("/owner/reservations/:id/complete", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "complete",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_completed", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation completed.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ complete error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Complete failed" });
  }
});

router.post("/owner/reservations/:id/no-show", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "no-show",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_no_show", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation marked as no-show.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ no-show error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "No-show failed" });
  }
});

router.post("/owner/reservations/:id/cancel", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const r = await closeReservationByOwner({
      restaurant_id: req.restaurant_id,
      reservationPkId: id,
      action: "cancel",
    });

    if (!r.ok) {
      return res.status(r.code).json({ success: false, version: APP_VERSION, error: r.error, data: r.data || null });
    }

    fireMakeEvent("reservation_cancelled", {
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: { id: r.row.id, reservation_id: r.row.reservation_id, status_before: r.status_before, status_after: r.status_after },
    });

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation cancelled.",
      data: { ...r.row, created_at_local: formatALDate(r.row.created_at), closed_at_local: formatALDate(r.row.closed_at) },
    });
  } catch (e) {
    console.error("❌ cancel error:", e);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Cancel failed" });
  }
});

// ==================== OWNER CONFIRM / DECLINE (ONLY PENDING) ====================
router.post("/owner/reservations/:id/confirm", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const before = await pool.query(
      `SELECT status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [id, req.restaurant_id]
    );
    const statusBefore = before.rows?.[0]?.status || null;
    const reservationUuid = before.rows?.[0]?.reservation_id || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Confirmed'
      WHERE id = $1
        AND restaurant_id = $2
        AND status = 'Pending'
      RETURNING
        id,
        reservation_id,
        restaurant_id,
        restaurant_name,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        status,
        created_at;
      `,
      [id, req.restaurant_id]
    );

    if (!up.rows.length) {
      if (!before.rows.length) {
        logOwnerDecision(req, "confirm", {
          actor: "owner_key",
          id,
          restaurant_id: req.restaurant_id,
          status_before: null,
          status_after: null,
        });
        return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
      }

      logOwnerDecision(req, "confirm", {
        actor: "owner_key",
        id,
        reservation_id: reservationUuid,
        restaurant_id: req.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });

      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: `Already decided: ${statusBefore}`,
      });
    }

    const row = up.rows[0];

    logOwnerDecision(req, "confirm", {
      actor: "owner_key",
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Confirmed",
    });

    pool
      .query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    const payload = {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    };

    fireMakeEvent("reservation_confirmed", payload);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation confirmed.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /owner/reservations/:id/confirm error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Confirm failed" });
  }
});

router.post("/owner/reservations/:id/decline", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Invalid id" });
    }

    const before = await pool.query(
      `SELECT status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [id, req.restaurant_id]
    );
    const statusBefore = before.rows?.[0]?.status || null;
    const reservationUuid = before.rows?.[0]?.reservation_id || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status = 'Declined'
      WHERE id = $1
        AND restaurant_id = $2
        AND status = 'Pending'
      RETURNING
        id,
        reservation_id,
        restaurant_id,
        restaurant_name,
        customer_name,
        phone,
        date,
        time,
        people,
        channel,
        area,
        status,
        created_at;
      `,
      [id, req.restaurant_id]
    );

    if (!up.rows.length) {
      if (!before.rows.length) {
        logOwnerDecision(req, "decline", {
          actor: "owner_key",
          id,
          restaurant_id: req.restaurant_id,
          status_before: null,
          status_after: null,
        });
        return res.status(404).json({ success: false, version: APP_VERSION, error: "Reservation not found" });
      }

      logOwnerDecision(req, "decline", {
        actor: "owner_key",
        id,
        reservation_id: reservationUuid,
        restaurant_id: req.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });

      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: `Already decided: ${statusBefore}`,
      });
    }

    const row = up.rows[0];

    logOwnerDecision(req, "decline", {
      actor: "owner_key",
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Declined",
    });

    pool
      .query(`UPDATE public.events SET status='Declined' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        req.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    const payload = {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: row.id,
        reservation_id: row.reservation_id,
        date: toYMD(row.date),
        time: String(row.time || "").slice(0, 5),
        people: Number(row.people || 0),
        customer_name: row.customer_name,
        phone: row.phone,
        channel: row.channel || null,
        area: row.area || null,
        status: row.status,
      },
    };

    fireMakeEvent("reservation_declined", payload);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: "Reservation declined.",
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /owner/reservations/:id/decline error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Decline failed" });
  }
});

// ==================== OWNER FEEDBACK ====================
router.post("/owner/feedback/send-one", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const s = await getFeedbackSettings(req.restaurant_id);
    if (!s.feedback_enabled) {
      return res.status(403).json({ success: false, version: APP_VERSION, error: "Feedback disabled by owner" });
    }

    const cu = await pool.query(
      `
      SELECT id, phone, full_name, consent_whatsapp, visits_count, feedback_last_sent_at
      FROM public.customers
      WHERE restaurant_id=$1 AND phone=$2
      LIMIT 1;
      `,
      [req.restaurant_id, phone]
    );
    if (!cu.rows.length) {
      return res.status(404).json({ success: false, version: APP_VERSION, error: "Customer not found" });
    }

    const c = cu.rows[0];
    if (!c.consent_whatsapp) {
      return res.status(409).json({ success: false, version: APP_VERSION, error: "Customer has no WhatsApp consent" });
    }

    const cooldownDays = Number(s.feedback_cooldown_days || 10);
    const okCooldown =
      !c.feedback_last_sent_at || new Date(c.feedback_last_sent_at).getTime() < Date.now() - cooldownDays * 86400000;
    if (!okCooldown) {
      return res
        .status(409)
        .json({ success: false, version: APP_VERSION, error: "Cooldown active (already contacted recently)" });
    }

    // Mark sent first (anti-spam)
    await pool.query(
      `
      UPDATE public.customers
      SET feedback_last_sent_at = NOW(), updated_at = NOW()
      WHERE id=$1 AND restaurant_id=$2;
      `,
      [c.id, req.restaurant_id]
    );

    fireFeedbackRequest({
      restaurant_id: req.restaurant_id,
      ts: new Date().toISOString(),
      data: {
        customer_id: c.id,
        phone: c.phone,
        full_name: c.full_name || "",
        template: s.feedback_template || "",
        mode: "manual_one",
      },
    });

    return res.json({ success: true, version: APP_VERSION, sent: true, phone: c.phone, customer_id: c.id });
  } catch (err) {
    console.error("❌ POST /owner/feedback/send-one error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.post("/owner/feedback/send-batch", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const date_from_in = String(req.body?.date_from || "").trim();
    const date_to_in = String(req.body?.date_to || "").trim();
    const limitReq = Number(req.body?.limit || 0);

    const s = await getFeedbackSettings(req.restaurant_id);
    if (!s.feedback_enabled) {
      return res.status(403).json({ success: false, version: APP_VERSION, error: "Feedback disabled by owner" });
    }

    const cooldownDays = Number(s.feedback_cooldown_days || 10);
    const excludeOver = Number(s.feedback_exclude_frequent_over_visits || 5);
    const batchLimit = Math.min(Math.max(limitReq || Number(s.feedback_batch_limit || 30), 1), 200);

    // Default: dje
    let from = date_from_in;
    let to = date_to_in;
    if (!from || !to) {
      const today = await getTodayAL();
      const y = (await pool.query(`SELECT ($1::date - INTERVAL '1 day')::date::text AS d;`, [today])).rows[0].d;
      from = y;
      to = y;
    }

    const q = await pool.query(
      `
      WITH candidates AS (
        SELECT DISTINCT
          cu.id AS customer_id,
          cu.phone,
          cu.full_name,
          cu.visits_count,
          cu.feedback_last_sent_at
        FROM public.reservations r
        JOIN public.customers cu
          ON cu.restaurant_id = r.restaurant_id
         AND cu.phone = r.phone
        WHERE r.restaurant_id = $1
          AND r.date::date BETWEEN $2::date AND $3::date
          AND cu.consent_whatsapp = TRUE
          AND (cu.feedback_last_sent_at IS NULL OR cu.feedback_last_sent_at < NOW() - ($4::int || ' days')::interval)
          AND (cu.visits_count IS NULL OR cu.visits_count <= $5::int)
      )
      SELECT * FROM candidates
      ORDER BY visits_count ASC NULLS FIRST
      LIMIT $6;
      `,
      [req.restaurant_id, from, to, cooldownDays, excludeOver, batchLimit]
    );

    const rows = q.rows;

    const ids = rows.map((x) => x.customer_id);
    if (ids.length) {
      await pool.query(
        `
        UPDATE public.customers
        SET feedback_last_sent_at = NOW(), updated_at = NOW()
        WHERE restaurant_id=$1 AND id = ANY($2::bigint[]);
        `,
        [req.restaurant_id, ids]
      );
    }

    for (const c of rows) {
      fireFeedbackRequest({
        restaurant_id: req.restaurant_id,
        ts: new Date().toISOString(),
        data: {
          customer_id: c.customer_id,
          phone: c.phone,
          full_name: c.full_name || "",
          template: s.feedback_template || "",
          mode: "manual_batch",
          date_from: from,
          date_to: to,
        },
      });
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      range: { from, to },
      sent_count: rows.length,
      sent: rows.map((x) => ({ customer_id: x.customer_id, phone: x.phone, full_name: x.full_name || "" })),
    });
  } catch (err) {
    console.error("❌ POST /owner/feedback/send-batch error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== DEBUG: SEND MAKE EVENT (OWNER ONLY) ====================
router.post("/owner/debug/make/:type", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const type = String(req.params.type || "").trim();
    if (!type) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing type" });

    const incoming = (req.body && typeof req.body === "object") ? req.body : {};

    const payload = {
      ...incoming,
      restaurant_id: req.restaurant_id,
      ts: incoming.ts || new Date().toISOString(),
    };

    fireMakeEvent(type, payload);

    return res.json({ success: true, version: APP_VERSION, sent_type: type, restaurant_id: req.restaurant_id });
  } catch (e) {
    return res.status(500).json({ success: false, version: APP_VERSION, error: e.message });
  }
});

// ===============================
// OWNER: Daily feedback report
// ===============================
router.get("/owner/reports/feedback/daily", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const q = `
      SELECT
        ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date)::text AS day,
        COUNT(*)::int AS total_feedback,
        ROUND(AVG(score)::numeric, 2) AS avg_score,
        SUM(CASE WHEN classification = 'risk' THEN 1 ELSE 0 END)::int AS risk_count,
        SUM(CASE WHEN classification = 'positive' THEN 1 ELSE 0 END)::int AS positive_count
      FROM public.feedback_messages
      WHERE direction='inbound'
        AND restaurant_id=$1
        AND (created_at AT TIME ZONE 'Europe/Tirane')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Tirane')::date;
    `;

    const r = await pool.query(q, [req.restaurant_id]);
    const row = r.rows[0] || null;
    const total = row ? Number(row.total_feedback || 0) : 0;

    if (!row || total === 0) {
      return res.json({
        success: true,
        version: APP_VERSION,
        restaurant_id: req.restaurant_id,
        message: "No feedback today",
        data: null,
      });
    }

    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: row });
  } catch (err) {
    console.error("❌ daily feedback report error", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "internal error" });
  }
});

// ==================== OWNER SUPPORT CHAT ====================
// FIX: replaced reservation_time with date::text, time::text and party_size with people
router.post('/owner/support/chat', requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const restRow = await pool.query('SELECT id, name FROM public.restaurants WHERE id=$1', [req.restaurant_id]);
    const restaurant = restRow.rows[0];
    const { message, history } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message mungon' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // --- DB context queries ---
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const [todayRes, pendingRes, totalCustRes, feedbackRes, recentRes] = await Promise.all([
      // Today's reservations (all statuses)
      pool.query(
        `SELECT customer_name, date::text, time::text, people, status
         FROM public.reservations
         WHERE restaurant_id=$1 AND date=$2
         ORDER BY time ASC`,
        [req.restaurant_id, today]
      ),
      // Pending reservations (upcoming)
      pool.query(
        `SELECT COUNT(*) AS cnt FROM public.reservations
         WHERE restaurant_id=$1 AND status='pending' AND date >= CURRENT_DATE`,
        [req.restaurant_id]
      ),
      // Total customers
      pool.query(
        `SELECT COUNT(*) AS cnt FROM public.customers WHERE restaurant_id=$1`,
        [req.restaurant_id]
      ),
      // Average feedback rating (last 30 days)
      pool.query(
        `SELECT ROUND(AVG((location_rating + hospitality_rating + food_rating + price_rating) / 4.0)::numeric, 1) AS avg_rating, COUNT(*) AS cnt
         FROM public.feedback
         WHERE restaurant_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [req.restaurant_id]
      ),
      // Last 5 reservations (any date)
      pool.query(
        `SELECT customer_name, date::text, time::text, people, status
         FROM public.reservations
         WHERE restaurant_id=$1
         ORDER BY date DESC, time DESC LIMIT 5`,
        [req.restaurant_id]
      ),
    ]);

    const todayList = todayRes.rows.map(r => {
      const t = r.time ? r.time.slice(0, 5) : '?';
      return `  • ${r.customer_name}, ora ${t}, ${r.people} persona (${r.status})`;
    }).join('\n') || '  (asnjë rezervim sot)';

    const recentList = recentRes.rows.map(r => {
      const d = r.date || '?';
      const t = r.time ? r.time.slice(0, 5) : '?';
      return `  • ${r.customer_name}, ${d} ${t}, ${r.people} persona (${r.status})`;
    }).join('\n') || '  (asnjë rezervim)';

    const avgRating = feedbackRes.rows[0]?.avg_rating || 'N/A';
    const feedbackCount = feedbackRes.rows[0]?.cnt || 0;
    const totalCustomers = totalCustRes.rows[0]?.cnt || 0;
    const pendingCount = pendingRes.rows[0]?.cnt || 0;

    const dbContext = `
GJENDJA AKTUALE E RESTORANTIT (${today}):
- Rezervime sot: ${todayRes.rows.length}
${todayList}
- Rezervime në pritje (të ardhshme): ${pendingCount}
- Total klientë: ${totalCustomers}
- Feedback mesatar (30 ditë): ${avgRating}/5 (${feedbackCount} vlerësime)

REZERVIMET E FUNDIT:
${recentList}`;
    // --- end DB context ---

    const systemPrompt = `Ti je Jerry, asistenti dixhital i platformës Te Ta AI.
Tani po flet me pronarin e restorantit "${restaurant.name}".

ROLI YT: Suport 24/7 për pronarin. Ndihmo me:
- Si të përdorë dashboard-in
- Si funksionojnë rezervimet, klientët, feedback, statistikat
- Probleme teknike të thjeshta
- Këshilla për biznesin
- Kur pronari pyet për të dhëna (rezervime, klientë, feedback), PËRDOR të dhënat reale nga databaza që kemi sot

RREGULLA:
- Fol shqip, i ngrohtë, profesional
- Përgjigju shkurt dhe konkretisht me numra dhe fakte reale
- Nëse pronari ka problem që TI nuk mund ta zgjidhësh (bug teknik, ndryshim plani, faturim, WhatsApp bot), thuaj: "Këtë do ta kaloj te Gerald (admin). Do t'ju kontaktojë së shpejti!" dhe shto [ESCALATE] në fillim të përgjigjes.
- Nëse pronari është i mërzitur ose ka ankesë serioze, gjithashtu [ESCALATE]
- Mos shpik informacion — nëse nuk di, thuaj "Nuk jam i sigurt, po e kaloj te admin"

RESTORANT: ${restaurant.name} (ID: ${restaurant.id})
${dbContext}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [...(history || []), { role: 'user', content: message }],
    });

    const reply = response.content[0].text;
    const needsEscalation = reply.includes('[ESCALATE]');
    const cleanReply = reply.replace('[ESCALATE]', '').trim();

    if (needsEscalation) {
      await pool.query(
        `INSERT INTO public.support_tickets (restaurant_id, restaurant_name, customer_message, jerry_reply, status, created_at)
         VALUES ($1,$2,$3,$4,'open',NOW())`,
        [restaurant.id, restaurant.name, message, cleanReply]
      );
    }

    res.json({ reply: cleanReply, escalated: needsEscalation });
  } catch (err) {
    console.error('Support chat error:', err.message);
    res.json({ reply: 'Kam një problem teknik. Ju lutem provoni përsëri ose na kontaktoni në WhatsApp.', escalated: false });
  }
});

// ==================== AI INSIGHTS (OWNER) ====================
router.get("/owner/ai/insights", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const rid = req.restaurant_id;
    const today = await getTodayAL();

    // 1. Rezervimet e 30 ditëve të fundit
    const resQ = await pool.query(`
      SELECT date::text AS date, time, people, status, channel, area, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
        AND date::date >= ($2::date - INTERVAL '30 days')::date
      ORDER BY date DESC, time DESC;
    `, [rid, today]);

    const reservations = resQ.rows;
    const total = reservations.length;
    const confirmed = reservations.filter(r => r.status === 'Confirmed' || r.status === 'Completed').length;
    const pending = reservations.filter(r => r.status === 'Pending').length;
    const noshow = reservations.filter(r => r.status === 'NoShow').length;
    const declined = reservations.filter(r => r.status === 'Declined').length;

    // 2. Dita me më shumë rezervime
    const byDay = {};
    for (const r of reservations) {
      const day = new Date(r.date).toLocaleDateString('sq-AL', { weekday: 'long', timeZone: 'Europe/Tirane' });
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const busiestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0] || null;
    const slowestDay = Object.entries(byDay).sort((a, b) => a[1] - b[1])[0] || null;

    // 3. Ora peak
    const byHour = {};
    for (const r of reservations) {
      const h = String(r.time || '').slice(0, 2);
      if (h) byHour[h] = (byHour[h] || 0) + 1;
    }
    const peakHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0] || null;

    // 4. Feedback trend (30 ditë)
    const fbQ = await pool.query(`
      SELECT
        ROUND(AVG((location_rating + hospitality_rating + food_rating + price_rating) / 4.0), 2) AS avg_rating,
        COUNT(*)::int AS total_feedback,
        ROUND(AVG(CASE WHEN created_at >= NOW() - INTERVAL '15 days'
          THEN (location_rating + hospitality_rating + food_rating + price_rating) / 4.0 END), 2) AS recent_avg,
        ROUND(AVG(CASE WHEN created_at < NOW() - INTERVAL '15 days'
          THEN (location_rating + hospitality_rating + food_rating + price_rating) / 4.0 END), 2) AS older_avg
      FROM public.feedback
      WHERE restaurant_id = $1
        AND created_at >= NOW() - INTERVAL '30 days';
    `, [rid]);
    const fb = fbQ.rows[0];
    const feedbackTrend = fb.recent_avg && fb.older_avg
      ? (Number(fb.recent_avg) > Number(fb.older_avg) ? 'rising' : Number(fb.recent_avg) < Number(fb.older_avg) ? 'falling' : 'stable')
      : 'insufficient_data';

    // 5. Klientët që po humbasin (>30 ditë pa ardhur)
    const lostQ = await pool.query(`
      SELECT COUNT(*)::int AS lost_count
      FROM public.customers
      WHERE restaurant_id = $1
        AND last_seen_at IS NOT NULL
        AND last_seen_at < NOW() - INTERVAL '30 days'
        AND visits_count >= 2;
    `, [rid]);
    const lostCustomers = lostQ.rows[0]?.lost_count || 0;

    // 6. Klientët VIP (3+ vizita)
    const vipQ = await pool.query(`
      SELECT COUNT(*)::int AS vip_count
      FROM public.customers
      WHERE restaurant_id = $1 AND visits_count >= 3;
    `, [rid]);
    const vipCount = vipQ.rows[0]?.vip_count || 0;

    // 7. No-show rate
    const noshowRate = total > 0 ? Math.round((noshow / total) * 100) : 0;

    // 8. Grupi mesatar
    const avgPeople = total > 0
      ? Math.round(reservations.reduce((s, r) => s + Number(r.people || 0), 0) / total)
      : 0;

    // 9. Gjenero insights si tekst
    const insights = [];

    if (busiestDay) insights.push(`📅 Dita më e ngarkuar: ${busiestDay[0]} (${busiestDay[1]} rezervime)`);
    if (slowestDay && slowestDay[0] !== busiestDay?.[0]) insights.push(`📉 Dita më e zbrazët: ${slowestDay[0]} (${slowestDay[1]} rezervime) — mundësi për promovim`);
    if (peakHour) insights.push(`⏰ Ora peak: ${peakHour[0]}:00 — sigurohu që stafi të jetë i plotë`);
    if (noshowRate >= 15) insights.push(`⚠️ No-show rate ${noshowRate}% — konsidero konfirmim manual 1 orë para`);
    else if (noshowRate > 0) insights.push(`✅ No-show rate i ulët: ${noshowRate}%`);
    if (feedbackTrend === 'rising') insights.push(`📈 Feedback po rritet — klientët janë gjithnjë e më të kënaqur`);
    if (feedbackTrend === 'falling') insights.push(`📉 Feedback po bie — kontrollo ankesat e fundit`);
    if (lostCustomers > 0) insights.push(`👋 ${lostCustomers} klientë të rregullt nuk kanë ardhur 30+ ditë — koha për ri-angazhim`);
    if (vipCount > 0) insights.push(`⭐ ${vipCount} klientë VIP (3+ vizita) — trajto ata me prioritet`);
    if (avgPeople >= 5) insights.push(`👥 Grupi mesatar: ${avgPeople} persona — kapaciteti i tavolinave të jetë i duhur`);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: rid,
      generated_at: new Date().toISOString(),
      period: "30 ditët e fundit",
      summary: {
        total_reservations: total,
        confirmed,
        pending,
        noshow,
        declined,
        noshow_rate_pct: noshowRate,
        avg_group_size: avgPeople,
        vip_customers: vipCount,
        at_risk_customers: lostCustomers,
        feedback_avg: fb.avg_rating || null,
        feedback_total: fb.total_feedback || 0,
        feedback_trend: feedbackTrend,
        busiest_day: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null,
        slowest_day: slowestDay ? { day: slowestDay[0], count: slowestDay[1] } : null,
        peak_hour: peakHour ? `${peakHour[0]}:00` : null,
      },
      insights,
    });
  } catch (err) {
    console.error("❌ GET /owner/ai/insights error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== BOT CONTROL ====================
router.post('/owner/bot/start', requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const rid = req.restaurant_id;
    await pool.query(
      `UPDATE public.restaurants SET bot_active = TRUE WHERE id = $1`,
      [rid]
    );
    return res.json({ success: true, version: APP_VERSION, bot_active: true });
  } catch (err) {
    console.error("❌ POST /owner/bot/start error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.post('/owner/bot/stop', requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const rid = req.restaurant_id;
    await pool.query(
      `UPDATE public.restaurants SET bot_active = FALSE WHERE id = $1`,
      [rid]
    );
    return res.json({ success: true, version: APP_VERSION, bot_active: false });
  } catch (err) {
    console.error("❌ POST /owner/bot/stop error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.get('/owner/bot/status', requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const rid = req.restaurant_id;
    const q = await pool.query(
      `SELECT bot_active FROM public.restaurants WHERE id = $1`,
      [rid]
    );
    const bot_active = q.rows[0]?.bot_active ?? true;
    return res.json({ success: true, version: APP_VERSION, bot_active });
  } catch (err) {
    console.error("❌ GET /owner/bot/status error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== MISSED MESSAGES ====================
router.get("/owner/reservations/active-by-phone", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: "Missing phone" });
    const result = await pool.query(
      `SELECT id, customer_name, phone, date, time, people, status
       FROM public.reservations
       WHERE restaurant_id = $1
         AND phone = $2
         AND status IN ('Confirmed','Pending')
         AND date >= CURRENT_DATE
       ORDER BY date ASC, time ASC
       LIMIT 1`,
      [req.restaurant_id, phone]
    );
    return res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/owner/missed-messages", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const result = await pool.query(
      `SELECT id, phone, message, received_at, handled_at, created_at
       FROM public.missed_messages
       WHERE restaurant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.restaurant_id, limit]
    );
    return res.json({ success: true, version: APP_VERSION, data: result.rows });
  } catch (err) {
    console.error("❌ GET missed-messages error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/owner/missed-message", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const { phone, message, received_at } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, error: "Missing phone" });

    await pool.query(`
      INSERT INTO public.missed_messages
        (restaurant_id, phone, message, received_at, created_at)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), NOW())
    `, [req.restaurant_id, phone, message || '', received_at || null]);

    return res.json({ success: true, version: APP_VERSION });
  } catch (err) {
    console.error("❌ missed-message error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CRON ENDPOINTS (called by WhatsApp bot) ====================

// POST /cron/reminders — find reservations ~18h away that haven't been reminded yet
router.post("/cron/reminders", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, phone, date::text AS date, time, people
       FROM public.reservations
       WHERE restaurant_id = $1
         AND status IN ('Confirmed', 'Pending')
         AND reminder_sent_at IS NULL
         AND (date::text || ' ' || time)::timestamp AT TIME ZONE 'Europe/Tirane'
             BETWEEN NOW() + INTERVAL '17 hours 30 minutes'
             AND     NOW() + INTERVAL '18 hours 30 minutes'`,
      [req.restaurant_id]
    );
    for (const row of result.rows) {
      await pool.query(
        `UPDATE public.reservations SET reminder_sent_at = NOW() WHERE id = $1`,
        [row.id]
      );
    }
    console.log(`🔔 Cron reminders: ${result.rows.length} rezervime`);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ /cron/reminders error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /cron/feedback-auto — find reservations ~24h ago that haven't received feedback request
router.post("/cron/feedback-auto", requireOwnerKey, requireDbReady, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, phone, date::text AS date, time, people
       FROM public.reservations
       WHERE restaurant_id = $1
         AND status IN ('Confirmed', 'Completed')
         AND feedback_requested_at IS NULL
         AND (date::text || ' ' || time)::timestamp AT TIME ZONE 'Europe/Tirane'
             BETWEEN NOW() - INTERVAL '25 hours'
             AND     NOW() - INTERVAL '23 hours'`,
      [req.restaurant_id]
    );
    for (const row of result.rows) {
      await pool.query(
        `UPDATE public.reservations SET feedback_requested_at = NOW() WHERE id = $1`,
        [row.id]
      );
    }
    console.log(`⭐ Cron feedback: ${result.rows.length} rezervime`);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ /cron/feedback-auto error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
