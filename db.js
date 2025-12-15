const { Pool, types } = require("pg");

// ✅ DATE (OID 1082) -> ktheje si string "YYYY-MM-DD" (mos e kthe në Date UTC)
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ✅ çdo lidhje e backend-it me DB përdor Europe/Tirane
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'Europe/Tirane'");
});

module.exports = pool;
