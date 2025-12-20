// db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // fix self-signed chain on Railway
  connectionTimeoutMillis: 5000,
});

module.exports = pool;
