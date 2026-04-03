// jerry/jerry.js
// Jerry — Guardian Agent i Te Ta AI Backend

const { runChecks, checkExpiringPlans }       = require('./watcher');
const { analyzeAnomaly }                     = require('./intelligence');
const { sendAlert, sendResolved, sendDailyReport, sendPlanExpiryAlert } = require('./reporter');
const memory = require('./memory');

async function startJerry(db) {
  console.log('🤖 Jerry u aktivizua — Te Ta AI Guardian');

  // ==================== LOOP KRYESOR çdo 60 sekonda ====================
  setInterval(async () => {
    try {
      const anomalies = await runChecks(db);

      for (const anomaly of anomalies) {
        try {
          const [recentIncidents, mem] = await Promise.all([
            memory.getRecentIncidents(db, 7),
            memory.getMemory(db, 'pattern', 3),
          ]);

          const analysis = await analyzeAnomaly(anomaly, recentIncidents, mem);

          const incidentStart = Date.now();
          const incidentId = await memory.saveIncident(db, {
            type:        anomaly.type,
            severity:    anomaly.severity,
            description: anomaly.description,
            cause:       analysis.cause,
          });

          await sendAlert(anomaly, analysis);

          if (analysis.canSelfHeal) {
            let actionTaken = 'Self-heal u provua';
            try {
              if (anomaly.type === 'stuck_reservations') {
                const result = await db.query(`
                  UPDATE reservations SET status = 'cancelled'
                  WHERE status = 'pending'
                    AND created_at < NOW() - INTERVAL '2 hours'
                `);
                actionTaken = `Auto-cancelled ${result.rowCount} rezervime të bllokuara`;
              } else if (anomaly.type === 'high_memory') {
                if (global.gc) {
                  global.gc();
                  actionTaken = 'Garbage collection u ekzekutua';
                } else {
                  actionTaken = 'GC nuk disponohet (--expose-gc mungon)';
                }
              }
            } catch (healErr) {
              actionTaken = `Self-heal dështoi: ${healErr.message}`;
            }

            const durationSeconds = Math.round((Date.now() - incidentStart) / 1000);
            await memory.resolveIncident(db, incidentId, actionTaken, durationSeconds);
            await sendResolved({ type: anomaly.type, action_taken: actionTaken }, durationSeconds);
          }

          await memory.saveMemory(
            db,
            'incident',
            'pattern',
            `${anomaly.type}: ${analysis.cause} → ${analysis.action}`
          );
        } catch (anomalyErr) {
          console.error('[Jerry] Anomaly processing error:', anomalyErr.message);
        }
      }
    } catch (err) {
      console.error('[Jerry] runChecks error:', err.message);
    }
  }, 60 * 1000);

  // ==================== RAPORT DITOR çdo orë ====================
  setInterval(async () => {
    try {
      const hour = new Date().toLocaleString('en-CA', {
        timeZone: 'Europe/Tirane',
        hour: 'numeric',
        hour12: false,
      });

      if (hour === '8') {
        const { rows: statsRows } = await db.query(`
          SELECT
            (SELECT COUNT(*) FROM reservations
             WHERE created_at::date = CURRENT_DATE) AS reservations_today,
            (SELECT COUNT(DISTINCT phone) FROM reservations
             WHERE created_at > NOW() - INTERVAL '30 days') AS active_customers,
            (SELECT COUNT(*) FROM jerry_incidents
             WHERE created_at > NOW() - INTERVAL '24 hours') AS incidents,
            (SELECT COUNT(*) FROM jerry_incidents
             WHERE created_at > NOW() - INTERVAL '24 hours'
               AND resolved = true) AS resolved
        `);

        const s = statsRows[0];
        const totalIncidents = Number(s.incidents);
        const resolvedIncidents = Number(s.resolved);
        const uptime = totalIncidents === 0
          ? 100
          : Math.round((resolvedIncidents / totalIncidents) * 100);

        const stats = {
          uptime,
          incidents:          totalIncidents,
          resolved:           resolvedIncidents,
          reservations_today: Number(s.reservations_today),
          active_customers:   Number(s.active_customers),
          prediction:         totalIncidents === 0
            ? 'Sistemi funksionon normalisht. ✅'
            : `${totalIncidents - resolvedIncidents} incidente akoma të hapura.`,
        };

        await sendDailyReport(stats);
        await memory.saveDailyLearning(db, {
          date:  new Date().toISOString().split('T')[0],
          stats,
        });

        // Check for expiring PRO plans → alert admin
        const expiryCheck = await checkExpiringPlans(db);
        if (expiryCheck) {
          await sendPlanExpiryAlert(expiryCheck.value);
          console.log(`[Jerry] Plan expiry alert sent for ${expiryCheck.value.length} restaurant(s)`);
        }
      }
    } catch (err) {
      console.error('[Jerry] daily report error:', err.message);
    }
  }, 60 * 60 * 1000);

  // ==================== SMART TRIGGERS çdo orë, ekzekuto ora 02:00 ====================
  setInterval(async () => {
    try {
      const hour = new Date().toLocaleString('en-CA', {
        timeZone: 'Europe/Tirane',
        hour: 'numeric',
        hour12: false,
      });

      if (hour !== '2') return;

      console.log('🎯 Jerry: Duke ekzekutuar Smart Triggers...');

      const restaurants = await db.query(
        "SELECT * FROM restaurants WHERE plan = 'pro' AND is_active = true"
      );

      for (const rest of restaurants.rows) {
        const triggers = await db.query(
          'SELECT * FROM marketing_triggers WHERE restaurant_id = $1 AND is_active = true',
          [rest.id]
        );

        for (const trigger of triggers.rows) {
          let shouldFire = false;
          let customers = [];

          if (trigger.trigger_type === 'inactive_45days') {
            const result = await db.query(`
              SELECT DISTINCT phone, name FROM reservations
              WHERE restaurant_id = $1
                AND phone NOT IN (
                  SELECT phone FROM reservations
                  WHERE restaurant_id = $1
                    AND created_at > NOW() - INTERVAL '45 days'
                )
            `, [rest.id]);
            customers = result.rows;
            shouldFire = customers.length > 0;
          }

          if (trigger.trigger_type === 'post_feedback_negative') {
            const result = await db.query(`
              SELECT DISTINCT r.phone, r.name
              FROM reservations r
              JOIN feedback f ON r.id = f.reservation_id
              WHERE r.restaurant_id = $1
                AND f.average_score < 3
                AND f.created_at > NOW() - INTERVAL '7 days'
            `, [rest.id]);
            customers = result.rows;
            shouldFire = customers.length > 0;
          }

          if (trigger.trigger_type === 'vip_reward') {
            const result = await db.query(`
              SELECT phone, name, COUNT(*) as visits
              FROM reservations
              WHERE restaurant_id = $1
                AND status IN ('confirmed', 'completed')
              GROUP BY phone, name
              HAVING COUNT(*) = 5
            `, [rest.id]);
            customers = result.rows;
            shouldFire = customers.length > 0;
          }

          if (!shouldFire || customers.length === 0) continue;

          let sent = 0;
          for (const customer of customers) {
            const message = trigger.message_template
              .replace('{name}', customer.name || 'i dashur')
              .replace('{restaurant}', rest.name);
            try {
              await fetch(
                `https://graph.facebook.com/v18.0/${process.env.WA_PHONE_ID}/messages`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${process.env.WA_PLATFORM_TOKEN}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: customer.phone.replace(/\D/g, ''),
                    type: 'text',
                    text: { body: message },
                  }),
                }
              );
              sent++;
            } catch (e) {
              console.error('Trigger send error:', e.message);
            }
          }

          await db.query(`
            INSERT INTO marketing_campaigns
              (restaurant_id, segment, channel, message,
               recipients_count, sent_count, triggered_by)
            VALUES ($1, $2, $3, $4, $5, $6, 'auto')
          `, [rest.id, trigger.segment || 'auto', trigger.channel,
              trigger.message_template, customers.length, sent]);

          await db.query(
            'UPDATE marketing_triggers SET last_run = NOW() WHERE id = $1',
            [trigger.id]
          );

          console.log(`✅ Trigger "${trigger.trigger_type}" — ${sent} mesazhe dërguar`);
        }
      }
    } catch (err) {
      console.error('Smart Triggers error:', err.message);
    }
  }, 60 * 60 * 1000);
}

module.exports = { startJerry };
