// jerry/memory.js
// Persistent memory layer — jerry_incidents + jerry_memory tables

async function saveIncident(db, incident) {
  const { rows } = await db.query(
    `INSERT INTO jerry_incidents (type, severity, description, cause)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [incident.type, incident.severity, incident.description, incident.cause || null]
  );
  return rows[0].id;
}

async function resolveIncident(db, incidentId, actionTaken, durationSeconds) {
  await db.query(
    `UPDATE jerry_incidents
     SET resolved = true, action_taken = $2, resolved_at = NOW(), duration_seconds = $3
     WHERE id = $1`,
    [incidentId, actionTaken, durationSeconds]
  );
}

async function getRecentIncidents(db, days = 7) {
  const { rows } = await db.query(
    `SELECT * FROM jerry_incidents
     WHERE created_at > NOW() - INTERVAL '${days} days'
     ORDER BY created_at DESC`
  );
  return rows;
}

async function saveMemory(db, type, category, content, metadata = {}) {
  const { rows } = await db.query(
    `INSERT INTO jerry_memory (type, category, content, metadata)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [type, category, content, metadata]
  );
  return rows[0].id;
}

async function getMemory(db, category, limit = 5) {
  const { rows } = await db.query(
    `SELECT * FROM jerry_memory
     WHERE category = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [category, limit]
  );
  return rows;
}

async function saveDailyLearning(db, learning) {
  return saveMemory(db, 'daily_learning', 'pattern', JSON.stringify(learning));
}

module.exports = {
  saveIncident,
  resolveIncident,
  getRecentIncidents,
  saveMemory,
  getMemory,
  saveDailyLearning,
};
