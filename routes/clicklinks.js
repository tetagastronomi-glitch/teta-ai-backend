const express = require("express");
const router = express.Router();
const pool = require("../db");
const { APP_VERSION } = require("../config/constants");
const { requireDbReady } = require("../middleware/db");
const { toYMD } = require("../lib/time");
const { fireMakeEvent } = require("../lib/notifications");
const { htmlPage } = require("../lib/html");

// ==================== HELPERS ====================
async function consumeOwnerToken(token, action) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, code: 400, error: "Missing token" };

  const q = await pool.query(
    `
    SELECT id, restaurant_id, reservation_id, action, expires_at, used_at
    FROM public.owner_action_tokens
    WHERE token=$1
    LIMIT 1;
    `,
    [t]
  );

  if (!q.rows.length) return { ok: false, code: 404, error: "Token not found" };

  const row = q.rows[0];
  if (row.action !== action) return { ok: false, code: 409, error: "Token action mismatch" };
  if (row.used_at) return { ok: false, code: 409, error: "Token already used" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, code: 410, error: "Token expired" };

  const u = await pool.query(
    `
    UPDATE public.owner_action_tokens
    SET used_at=NOW()
    WHERE token=$1 AND used_at IS NULL
    RETURNING token;
    `,
    [t]
  );
  if (!u.rows.length) return { ok: false, code: 409, error: "Token already used" };

  // reservation_id here is the numeric PK id (public.reservations.id)
  return { ok: true, restaurant_id: row.restaurant_id, reservation_pk_id: row.reservation_id };
}

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

// ==================== CLICK LINKS ====================
router.get("/o/confirm/:token", requireDbReady, async (req, res) => {
  try {
    const consumed = await consumeOwnerToken(req.params.token, "confirm");
    if (!consumed.ok) {
      logOwnerDecision(req, "confirm", {
        actor: "click_link",
        token: req.params.token,
        status_before: null,
        status_after: null,
      });
      return res.status(consumed.code).send(htmlPage("Error", consumed.error));
    }

    // Fetch current state for better logging
    const before = await pool.query(
      `SELECT id, status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );
    const id = before.rows?.[0]?.id || null;
    const statusBefore = before.rows?.[0]?.status || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status='Confirmed'
      WHERE id=$1 AND restaurant_id=$2 AND status='Pending'
      RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at;
      `,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );

    if (!up.rows.length) {
      logOwnerDecision(req, "confirm", {
        actor: "click_link",
        token: req.params.token,
        id,
        reservation_id: before.rows?.[0]?.reservation_id || null,
        restaurant_id: consumed.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });
      return res.status(409).send(htmlPage("Already decided", "Rezervimi nuk është më Pending."));
    }

    const row = up.rows[0];

    logOwnerDecision(req, "confirm", {
      actor: "click_link",
      token: req.params.token,
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Confirmed",
    });

    pool
      .query(`UPDATE public.events SET status='Confirmed' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        row.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    fireMakeEvent("reservation_confirmed", {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name,
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
    });

    return res.status(200).send(htmlPage("✅ Confirmed", "Rezervimi u konfirmua me sukses."));
  } catch (e) {
    console.error("❌ GET /o/confirm/:token error:", e);
    logOwnerDecision(req, "confirm", { actor: "click_link", token: req.params.token, status_before: null, status_after: null });
    return res.status(500).send(htmlPage("Error", "Confirm failed"));
  }
});

router.get("/o/decline/:token", requireDbReady, async (req, res) => {
  try {
    const consumed = await consumeOwnerToken(req.params.token, "decline");
    if (!consumed.ok) {
      logOwnerDecision(req, "decline", {
        actor: "click_link",
        token: req.params.token,
        status_before: null,
        status_after: null,
      });
      return res.status(consumed.code).send(htmlPage("Error", consumed.error));
    }

    const before = await pool.query(
      `SELECT id, status, reservation_id FROM public.reservations WHERE id=$1 AND restaurant_id=$2 LIMIT 1;`,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );
    const id = before.rows?.[0]?.id || null;
    const statusBefore = before.rows?.[0]?.status || null;

    const up = await pool.query(
      `
      UPDATE public.reservations
      SET status='Declined'
      WHERE id=$1 AND restaurant_id=$2 AND status='Pending'
      RETURNING id, reservation_id, restaurant_id, restaurant_name, customer_name, phone, date, time, people, channel, area, status, created_at;
      `,
      [consumed.reservation_pk_id, consumed.restaurant_id]
    );

    if (!up.rows.length) {
      logOwnerDecision(req, "decline", {
        actor: "click_link",
        token: req.params.token,
        id,
        reservation_id: before.rows?.[0]?.reservation_id || null,
        restaurant_id: consumed.restaurant_id,
        status_before: statusBefore,
        status_after: statusBefore,
      });
      return res.status(409).send(htmlPage("Already decided", "Rezervimi nuk është më Pending."));
    }

    const row = up.rows[0];

    logOwnerDecision(req, "decline", {
      actor: "click_link",
      token: req.params.token,
      id: row.id,
      reservation_id: row.reservation_id,
      restaurant_id: row.restaurant_id,
      status_before: statusBefore,
      status_after: "Declined",
    });

    pool
      .query(`UPDATE public.events SET status='Declined' WHERE restaurant_id=$1 AND reservation_id=$2;`, [
        row.restaurant_id,
        row.reservation_id,
      ])
      .catch(() => {});

    fireMakeEvent("reservation_declined", {
      restaurant_id: row.restaurant_id,
      restaurant_name: row.restaurant_name,
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
    });

    return res.status(200).send(htmlPage("❌ Declined", "Rezervimi u refuzua."));
  } catch (e) {
    console.error("❌ GET /o/decline/:token error:", e);
    logOwnerDecision(req, "decline", { actor: "click_link", token: req.params.token, status_before: null, status_after: null });
    return res.status(500).send(htmlPage("Error", "Decline failed"));
  }
});

module.exports = router;
