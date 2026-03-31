// jerry/watcher.js
// Health checks: backend, database, stuck reservations, memory, response time

const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

async function checkBackendHealth() {
  const start = Date.now();
  try {
    await axios.get(`${BACKEND_URL}/health`, { timeout: 5000 });
    const ms = Date.now() - start;

    if (ms > 3000) {
      return {
        type: 'slow_response',
        severity: 5,
        description: `Backend /health u përgjigj në ${ms}ms (> 3000ms)`,
        value: ms,
        timestamp: new Date(),
      };
    }
    return null;
  } catch (err) {
    const ms = Date.now() - start;
    return {
      type: 'backend_down',
      severity: 8,
      description: `Backend nuk u përgjigj brenda 5 sekondave: ${err.message}`,
      value: ms,
      timestamp: new Date(),
    };
  }
}

async function checkDatabaseHealth(db) {
  try {
    await db.query('SELECT 1');
    return null;
  } catch (err) {
    return {
      type: 'database_down',
      severity: 9,
      description: `Database nuk përgjigjet: ${err.message}`,
      value: err.message,
      timestamp: new Date(),
    };
  }
}

async function checkStuckReservations(db) {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) AS count FROM reservations
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '2 hours'
    `);
    const count = Number(rows[0].count);
    if (count > 0) {
      return {
        type: 'stuck_reservations',
        severity: 4,
        description: `${count} rezervime kanë mbetur pending për mbi 2 orë`,
        value: count,
        timestamp: new Date(),
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

function checkMemoryUsage() {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (mb > 400) {
    return {
      type: 'high_memory',
      severity: 6,
      description: `Përdorimi i memories është ${mb.toFixed(1)}MB (> 400MB)`,
      value: mb,
      timestamp: new Date(),
    };
  }
  return null;
}

async function runChecks(db) {
  const [backend, database, stuck, memory] = await Promise.all([
    checkBackendHealth(),
    checkDatabaseHealth(db),
    checkStuckReservations(db),
    Promise.resolve(checkMemoryUsage()),
  ]);

  return [backend, database, stuck, memory].filter(Boolean);
}

module.exports = { runChecks };
