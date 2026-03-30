// db.js
const { Pool, types } = require("pg");

// Return DATE columns as plain "YYYY-MM-DD" strings (not JS Date objects)
types.setTypeParser(1082, val => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // fix self-signed chain on Railway
  connectionTimeoutMillis: 5000,
});

module.exports = pool;
