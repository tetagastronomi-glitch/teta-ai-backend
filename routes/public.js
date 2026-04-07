const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { requireApiKey, requirePlan } = require("../middleware/auth");
const { requireDbReady } = require("../middleware/db");
const { formatALDate, getTodayAL, toYMD, normalizeTimeHHMI, rejectIfTimePassedTodayAL } = require("../lib/time");
const { fireMakeEvent } = require("../lib/notifications");
const { getRestaurantRules, decideReservationStatus } = require("../lib/status");
const { normalizeFeedbackRatings, toBoolOrNull, segmentFromDays } = require("../lib/ratings");
const { validate, reservationSchema } = require("../middleware/validate");

// ==================== CONSENTS (LEGAL) ====================
router.post("/consents", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const phone = String(b.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });
    }

    const full_name = b.full_name !== undefined ? String(b.full_name || "").trim() : null;

    const c_marketing = toBoolOrNull(b.consent_marketing ?? b.marketing);
    const c_sms = toBoolOrNull(b.consent_sms ?? b.sms);
    const c_whatsapp = toBoolOrNull(b.consent_whatsapp ?? b.whatsapp);
    const c_email = toBoolOrNull(b.consent_email ?? b.email);

    const anyProvided = [c_marketing, c_sms, c_whatsapp, c_email].some((x) => x !== null);
    if (!anyProvided && full_name === null) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: "No consent fields provided (send whatsapp/sms/email/marketing OR consent_* OR full_name).",
      });
    }

    const consent_source = b.consent_source ? String(b.consent_source).trim() : "manual";

    const q = await pool.query(
      `
      INSERT INTO public.customers (
        restaurant_id,
        phone,
        full_name,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        consent_source,
        consent_updated_at
      )
      VALUES (
        $1::bigint,
        $2::text,
        NULLIF($3::text,''),
        COALESCE($4::boolean, FALSE),
        COALESCE($5::boolean, FALSE),
        COALESCE($6::boolean, FALSE),
        COALESCE($7::boolean, FALSE),
        $8::text,
        NOW()
      )
      ON CONFLICT (restaurant_id, phone)
      DO UPDATE SET
        full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.customers.full_name),
        consent_marketing = COALESCE($4::boolean, public.customers.consent_marketing),
        consent_sms = COALESCE($5::boolean, public.customers.consent_sms),
        consent_whatsapp = COALESCE($6::boolean, public.customers.consent_whatsapp),
        consent_email = COALESCE($7::boolean, public.customers.consent_email),
        consent_source = $8::text,
        consent_updated_at = NOW(),
        updated_at = NOW()
      RETURNING
        id, restaurant_id, phone, full_name,
        consent_marketing, consent_sms, consent_whatsapp, consent_email,
        consent_source, consent_updated_at,
        created_at, updated_at;
      `,
      [req.restaurant_id, phone, full_name, c_marketing, c_sms, c_whatsapp, c_email, consent_source]
    );

    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: q.rows[0] });
  } catch (err) {
    console.error("❌ POST /consents error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== SEGMENTS + AUDIENCE (PRO) ====================
router.get("/segments", requireApiKey, requireDbReady, requirePlan("PRO"), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 60), 1), 3650);
    const today = await getTodayAL();

    const q = await pool.query(
      `
      SELECT
        id,
        phone,
        full_name,
        visits_count,
        last_seen_at,
        consent_marketing,
        consent_sms,
        consent_whatsapp,
        consent_email,
        ( ($1::date) - ((last_seen_at AT TIME ZONE 'Europe/Tirane')::date) )::int AS days_since_last
      FROM public.customers
      WHERE restaurant_id = $2
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
        AND last_seen_at <= NOW()
        AND (last_seen_at AT TIME ZONE 'Europe/Tirane')::date >= ($1::date - ($3::int || ' days')::interval)::date
      ORDER BY last_seen_at DESC;
      `,
      [today, req.restaurant_id, days]
    );

    const rows = q.rows.map((r) => ({
      id: String(r.id),
      phone: r.phone,
      full_name: r.full_name || "",
      visits_count: Number(r.visits_count || 0),
      last_seen_at: r.last_seen_at,
      last_seen_at_local: formatALDate(r.last_seen_at),
      consent_marketing: !!r.consent_marketing,
      consent_sms: !!r.consent_sms,
      consent_whatsapp: !!r.consent_whatsapp,
      consent_email: !!r.consent_email,
      days_since_last: Number.isFinite(Number(r.days_since_last)) ? Number(r.days_since_last) : null,
      segment: segmentFromDays(r.days_since_last),
    }));

    const vip = rows.filter((r) => r.visits_count >= 3);
    const active = rows.filter((r) => r.segment === "ACTIVE");
    const warm = rows.filter((r) => r.segment === "WARM");
    const cold = rows.filter((r) => r.segment === "COLD");
    const unknown = rows.filter((r) => r.segment === "UNKNOWN");

    const counts = {
      total: rows.length,
      vip: vip.length,
      active: active.length,
      warm: warm.length,
      cold: cold.length,
      unknown: unknown.length,
      whatsapp_true: rows.filter((r) => r.consent_whatsapp).length,
      marketing_true: rows.filter((r) => r.consent_marketing).length,
      sms_true: rows.filter((r) => r.consent_sms).length,
      email_true: rows.filter((r) => r.consent_email).length,
    };

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      params: { days },
      counts,
      data: { vip, active, warm, cold, unknown },
    });
  } catch (err) {
    console.error("❌ GET /segments error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.get("/audience/export", requireApiKey, requireDbReady, requirePlan("PRO"), async (req, res) => {
  try {
    const channel = String(req.query.channel || "whatsapp").trim().toLowerCase();
    const segment = String(req.query.segment || "all").trim().toLowerCase();
    const format = String(req.query.format || "json").trim().toLowerCase();
    const days = Math.min(Math.max(Number(req.query.days || 60), 1), 3650);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 2000);

    const consentColumn =
      channel === "sms"
        ? "consent_sms"
        : channel === "email"
        ? "consent_email"
        : channel === "marketing"
        ? "consent_marketing"
        : "consent_whatsapp";

    const today = await getTodayAL();

    const q = await pool.query(
      `
      SELECT
        phone,
        full_name,
        visits_count,
        last_seen_at,
        ( ($1::date) - ((last_seen_at AT TIME ZONE 'Europe/Tirane')::date) )::int AS days_since_last_visit
      FROM public.customers
      WHERE restaurant_id = $2
        AND phone IS NOT NULL AND phone <> ''
        AND last_seen_at IS NOT NULL
        AND last_seen_at <= NOW()
        AND (last_seen_at AT TIME ZONE 'Europe/Tirane')::date >= ($1::date - ($4::int || ' days')::interval)::date
        AND ${consentColumn} = TRUE
      ORDER BY last_seen_at DESC
      LIMIT $3;
      `,
      [today, req.restaurant_id, limit, days]
    );

    let rows = q.rows.map((r) => ({
      phone: r.phone,
      full_name: r.full_name || "",
      visits_count: Number(r.visits_count || 0),
      segment: segmentFromDays(r.days_since_last_visit),
      days_since_last_visit: Number.isFinite(Number(r.days_since_last_visit)) ? Number(r.days_since_last_visit) : null,
      last_seen_at: r.last_seen_at,
      last_seen_at_local: formatALDate(r.last_seen_at),
    }));

    if (segment !== "all") {
      const want = segment.toUpperCase();
      rows = rows.filter((r) => r.segment === want);
    }

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      const header = ["phone", "full_name", "segment", "visits_count", "days_since_last_visit", "last_seen_at_local"].join(
        ","
      );
      const body = rows
        .map((r) =>
          [
            r.phone,
            `"${String(r.full_name || "").replaceAll('"', '""')}"`,
            r.segment,
            r.visits_count,
            r.days_since_last_visit ?? "",
            `"${String(r.last_seen_at_local || "").replaceAll('"', '""')}"`,
          ].join(",")
        )
        .join("\n");
      return res.status(200).send(header + "\n" + body);
    }

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      filter: { channel, segment, days, limit, format: "json" },
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /audience/export error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== EVENTS (CORE) ====================
router.post("/events", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["event_date", "event_time"];
    for (const f of required) {
      if (!b[f]) {
        return res.status(400).json({ success: false, version: APP_VERSION, error: `Missing field: ${f}` });
      }
    }

    const people = b.people === undefined || b.people === null || b.people === "" ? null : Number(b.people);
    if (people !== null && (!Number.isFinite(people) || people <= 0)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "people must be positive number" });
    }

    const status = b.status || "Pending";

    const result = await pool.query(
      `
      INSERT INTO public.events
      (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
      VALUES
      ($1,$2,$3,$4,$5::date,$6::time,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, created_at;
      `,
      [
        req.restaurant_id,
        b.customer_id || null,
        b.reservation_id || null,
        b.event_type || "restaurant_reservation",
        String(b.event_date).trim(),
        normalizeTimeHHMI(b.event_time),
        people,
        status,
        b.source || b.channel || null,
        b.area || null,
        b.allergies ?? "",
        b.special_requests ?? "",
        b.notes ?? "",
        b.created_by || "AI",
      ]
    );

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: { id: row.id, created_at: row.created_at, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

router.get("/events", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, customer_id, reservation_id,
        event_type, event_date, event_time, people,
        status, source, area, allergies, special_requests, notes,
        created_by, created_at
      FROM public.events
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /events error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== RESERVATIONS ====================
router.post("/reservations", requireApiKey, requireDbReady, validate(reservationSchema), async (req, res) => {
  try {
    const r = req.body || {};
    const v = req.validated;
    const people = v.people;
    const dateStr = v.date;

    // strict normalize HH:MI
    const timeStr = normalizeTimeHHMI(v.time);
    if (!timeStr) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error: "Ora është e pavlefshme.",
        error_code: "INVALID_TIME",
      });
    }

    // reject if today and time passed
    const guard = await rejectIfTimePassedTodayAL(dateStr, timeStr);
    if (!guard.ok) {
      return res.status(400).json({
        success: false,
        version: APP_VERSION,
        error_code: guard.error_code || "TIME_PASSED",
        error:
          guard.message ||
          "Ora që ke zgjedhur ka kaluar.\nTë lutem zgjidh një orë tjetër sot ose një ditë tjetër.",
      });
    }

    // Opening hours + capacity validation
    const rules = await getRestaurantRules(req.restaurant_id);
    if (timeStr < rules.openingStart || timeStr >= rules.openingEnd) {
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
    const status = decision.status;

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
      VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, reservation_id, created_at, status;
      `,
      [
        req.restaurant_id,
        reservation_id,
        r.restaurant_name || "Te Ta Gastronomi",
        r.customer_name,
        r.phone,
        dateStr,
        timeStr,
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

    const inserted = result.rows[0];

    const payload = {
      restaurant_id: req.restaurant_id,
      restaurant_name: r.restaurant_name || "Te Ta Gastronomi",
      ts: new Date().toISOString(),
      data: {
        id: inserted.id,
        reservation_id: inserted.reservation_id,
        date: dateStr,
        time: timeStr,
        people,
        customer_name: r.customer_name,
        phone: r.phone,
        channel: r.channel || null,
        area: r.area || null,
        status: inserted.status,
        reason: decision.reason || null,
      },
    };

    // CLICK LINKS only for Pending
    if (status === "Pending") {
      const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      if (!base) console.error("⚠️ PUBLIC_BASE_URL not set — confirm/decline links broken!");

      const confirmToken = crypto.randomBytes(18).toString("hex");
      const declineToken = crypto.randomBytes(18).toString("hex");

      await pool.query(
        `
        INSERT INTO public.owner_action_tokens (restaurant_id, reservation_id, token, action, expires_at)
        VALUES
          ($1,$2,$3,'confirm', NOW() + INTERVAL '2 hours'),
          ($1,$2,$4,'decline', NOW() + INTERVAL '2 hours');
        `,
        [req.restaurant_id, inserted.id, confirmToken, declineToken]
      );

      if (base) {
        payload.data.confirm_url = `${base}/o/confirm/${confirmToken}`;
        payload.data.decline_url = `${base}/o/decline/${declineToken}`;
      } else {
        payload.data.confirm_url = null;
        payload.data.decline_url = null;
      }
    }

    // Make events
    if (inserted.status === "Pending") fireMakeEvent("reservation_created", payload);
    else fireMakeEvent("reservation_confirmed", payload);

    // Sync to customers (non-blocking)
    try {
      await pool.query(
        `
        WITH flags AS (
          SELECT
            NOW() AS now_ts,
            (($1::date + $2::time) AT TIME ZONE 'Europe/Tirane') AS ts,
            CASE WHEN (($1::date + $2::time) AT TIME ZONE 'Europe/Tirane') <= NOW() THEN 1 ELSE 0 END AS is_past
        )
        INSERT INTO public.customers (
          restaurant_id, phone, full_name,
          first_seen_at, last_seen_at, visits_count,
          created_at, updated_at
        )
        VALUES (
          $3, $4, NULLIF($5,''),
          (SELECT now_ts FROM flags),
          (SELECT CASE WHEN is_past=1 THEN ts ELSE NULL END FROM flags),
          (SELECT CASE WHEN is_past=1 THEN 1 ELSE 0 END FROM flags),
          NOW(), NOW()
        )
        ON CONFLICT (restaurant_id, phone)
        DO UPDATE SET
          full_name = COALESCE(NULLIF(EXCLUDED.full_name,''), public.customers.full_name),
          first_seen_at = COALESCE(public.customers.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = CASE
            WHEN (SELECT is_past FROM flags)=1
            THEN GREATEST(COALESCE(public.customers.last_seen_at, (SELECT ts FROM flags)), (SELECT ts FROM flags))
            ELSE public.customers.last_seen_at
          END,
          visits_count = public.customers.visits_count + (SELECT CASE WHEN is_past=1 THEN 1 ELSE 0 END FROM flags),
          updated_at = NOW();
        `,
        [dateStr, timeStr, req.restaurant_id, r.phone, r.customer_name]
      );
    } catch (e) {
      console.error("⚠️ Sync to customers failed (non-blocking):", e.message);
    }

    // Sync to events (non-blocking)
    try {
      await pool.query(
        `
        INSERT INTO public.events
        (restaurant_id, customer_id, reservation_id, event_type, event_date, event_time, people, status, source, area, allergies, special_requests, notes, created_by)
        VALUES
        ($1,$2,$3,'restaurant_reservation',$4::date,$5::time,$6,$7,$8,$9,$10,$11,$12,$13);
        `,
        [
          req.restaurant_id,
          null,
          reservation_id,
          dateStr,
          timeStr,
          people,
          status,
          r.channel || null,
          r.area || null,
          r.allergies || "",
          r.special_requests || "",
          "Synced from /reservations",
          "AI",
        ]
      );
    } catch (e) {
      console.error("⚠️ Sync to events failed (non-blocking):", e.message);
    }

    const httpStatus = status === "Pending" ? 202 : 201;

    return res.status(httpStatus).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      message: status === "Pending" ? "Reservation pending owner approval." : "Reservation confirmed.",
      data: { ...inserted, created_at_local: formatALDate(inserted.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /reservations error:", err);
    if (err && err.code === "23505") {
      return res.status(409).json({
        success: false,
        version: APP_VERSION,
        error: "Duplicate reservation",
        detail: err.detail || null,
        code: err.code,
      });
    }
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message, code: err.code || null });
  }
});

router.get("/reservations", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 50);

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests,
        status, feedback_requested_at, feedback_received_at, created_at
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
    console.error("❌ GET /reservations error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.get("/reservations/upcoming", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);

    const today = await getTodayAL();
    const end = (await pool.query(`SELECT ($1::date + ($2::int || ' days')::interval)::date AS d`, [today, days])).rows[0].d;

    const result = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests,
        status, feedback_requested_at, feedback_received_at, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
        AND date::date >= $2::date
        AND date::date <= $3::date
      ORDER BY date ASC, time ASC, created_at ASC;
      `,
      [req.restaurant_id, today, end]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));

    return res.json({
      success: true,
      version: APP_VERSION,
      range: { from: today, to: end, days },
      restaurant_id: req.restaurant_id,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("❌ GET /reservations/upcoming error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== FEEDBACK ====================
router.post("/feedback", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const phone = req.body?.phone;
    if (!phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "Missing field: phone" });

    const ratings = normalizeFeedbackRatings(req.body);
    if (Object.values(ratings).some((v) => v === null)) {
      return res
        .status(400)
        .json({ success: false, version: APP_VERSION, error: "Ratings must be numbers between 1 and 5" });
    }

    const reservation_pk_id = req.body?.reservation_id ? Number(req.body.reservation_id) : null;
    const reservationIdSafe = Number.isFinite(reservation_pk_id) ? reservation_pk_id : null;

    const result = await pool.query(
      `
      INSERT INTO public.feedback
        (restaurant_id, restaurant_name, phone,
         location_rating, hospitality_rating, food_rating, price_rating, comment, reservation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, created_at;
      `,
      [
        req.restaurant_id,
        "Te Ta Gastronomi",
        String(phone).trim(),
        ratings.location_rating,
        ratings.hospitality_rating,
        ratings.food_rating,
        ratings.price_rating,
        req.body.comment || "",
        reservationIdSafe,
      ]
    );

    // Mark "received" timestamps (best-effort)
    pool
      .query(
        `UPDATE public.customers SET feedback_last_received_at=NOW(), updated_at=NOW()
         WHERE restaurant_id=$1 AND phone=$2;`,
        [req.restaurant_id, String(phone).trim()]
      )
      .catch(() => {});

    if (reservationIdSafe) {
      pool
        .query(
          `UPDATE public.reservations SET feedback_received_at=NOW()
           WHERE restaurant_id=$1 AND id=$2;`,
          [req.restaurant_id, reservationIdSafe]
        )
        .catch(() => {});
    }

    const row = result.rows[0];
    return res.status(201).json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: { ...row, created_at_local: formatALDate(row.created_at) },
    });
  } catch (err) {
    console.error("❌ POST /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

router.get("/feedback", requireApiKey, requireDbReady, async (req, res) => {
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
        reservation_id,
        created_at
      FROM public.feedback
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [req.restaurant_id, limit]
    );

    const rows = result.rows.map((x) => ({ ...x, created_at_local: formatALDate(x.created_at) }));
    return res.json({ success: true, version: APP_VERSION, restaurant_id: req.restaurant_id, data: rows });
  } catch (err) {
    console.error("❌ GET /feedback error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ==================== REPORTS ====================
router.get("/reports/today", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const today = await getTodayAL();

    const reservations = await pool.query(
      `
      SELECT
        id, restaurant_id, reservation_id, restaurant_name,
        customer_name, phone,
        date::text AS date,
        time, people, channel, area,
        first_time, allergies, special_requests, status,
        feedback_requested_at, feedback_received_at, created_at
      FROM public.reservations
      WHERE restaurant_id = $1
        AND date::date = $2::date
      ORDER BY time ASC;
      `,
      [req.restaurant_id, today]
    );

    const reservationsRows = reservations.rows.map((x) => ({
      ...x,
      created_at_local: formatALDate(x.created_at),
    }));

    const feedback = await pool.query(
      `
      SELECT
        id, restaurant_id, restaurant_name, phone,
        location_rating, hospitality_rating, food_rating, price_rating,
        ROUND((location_rating + hospitality_rating + food_rating + price_rating) / 4.0, 1) AS avg_rating,
        comment, reservation_id, created_at
      FROM public.feedback
      WHERE restaurant_id = $1
        AND (created_at AT TIME ZONE 'Europe/Tirane')::date = $2::date
      ORDER BY created_at DESC;
      `,
      [req.restaurant_id, today]
    );

    const feedbackRows = feedback.rows.map((f) => ({
      ...f,
      created_at_local: formatALDate(f.created_at),
    }));

    const feedbackCount = feedbackRows.length;

    const avgOfAvg =
      feedbackCount === 0
        ? null
        : Math.round((feedbackRows.reduce((s, x) => s + Number(x.avg_rating || 0), 0) / feedbackCount) * 10) / 10;

    const fiveStars = feedbackCount === 0 ? 0 : feedbackRows.filter((x) => Number(x.avg_rating) >= 5).length;
    const fiveStarsPct = feedbackCount === 0 ? 0 : Math.round((fiveStars / feedbackCount) * 100);

    return res.json({
      success: true,
      version: APP_VERSION,
      date_local: today,
      restaurant_id: req.restaurant_id,
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
    return res.status(500).json({ success: false, version: APP_VERSION, error: err.message });
  }
});

// ===============================
// FEEDBACK: Save messages from Make / WhatsApp
// POST /feedback/messages
// ===============================
router.post("/feedback/messages", requireApiKey, requireDbReady, async (req, res) => {
  try {
    const {
      twilio_message_sid = null,
      feedback_request_id = null,
      from_phone,
      message_body,
      direction = "inbound",
      classification = null,
      score = null,
    } = req.body || {};

    if (!from_phone) return res.status(400).json({ success: false, version: APP_VERSION, error: "from_phone is required" });
    if (!message_body) return res.status(400).json({ success: false, version: APP_VERSION, error: "message_body is required" });

    const dir = String(direction || "").trim().toLowerCase();
    if (!["inbound", "outbound"].includes(dir)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "direction must be inbound|outbound" });
    }

    const parsedScore = score === null || score === undefined || score === "" ? null : Number(score);
    if (parsedScore !== null && (!Number.isInteger(parsedScore) || parsedScore < 1 || parsedScore > 10)) {
      return res.status(400).json({ success: false, version: APP_VERSION, error: "score must be integer 1-10 (or null)" });
    }

    const q = `
      INSERT INTO public.feedback_messages
        (twilio_message_sid, feedback_request_id, restaurant_id, from_phone, message_body, direction, classification, score)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (twilio_message_sid) DO NOTHING
      RETURNING id, restaurant_id, from_phone, classification, score, created_at;
    `;

    const vals = [
      twilio_message_sid,
      feedback_request_id,
      req.restaurant_id,
      String(from_phone).trim(),
      String(message_body),
      dir,
      classification ? String(classification) : null,
      parsedScore,
    ];

    const result = await pool.query(q, vals);

    return res.json({
      success: true,
      version: APP_VERSION,
      restaurant_id: req.restaurant_id,
      data: result.rows[0] || null,
      duplicate: result.rows.length === 0,
    });
  } catch (err) {
    console.error("❌ POST /feedback/messages error:", err);
    return res.status(500).json({ success: false, version: APP_VERSION, error: "Internal server error" });
  }
});

module.exports = router;
