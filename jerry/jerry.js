// jerry/jerry.js
// Jerry — Guardian Agent i Te Ta AI Backend

const { runChecks }                          = require('./watcher');
const { analyzeAnomaly }                     = require('./intelligence');
const { sendAlert, sendResolved, sendDailyReport } = require('./reporter');
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
      }
    } catch (err) {
      console.error('[Jerry] daily report error:', err.message);
    }
  }, 60 * 60 * 1000);
}

module.exports = { startJerry };
