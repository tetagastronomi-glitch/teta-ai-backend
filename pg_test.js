require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const url = process.env.DATABASE_URL;

  console.log("Has DATABASE_URL:", !!url);
  if (!url) {
    console.error("❌ DATABASE_URL missing");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log("Connecting...");
    await client.connect();
    console.log("✅ Connected.");

    const r = await client.query("select now() as now, current_database() as db");
    console.log("✅ Query OK:", r.rows[0]);

    await client.end();
    console.log("✅ Closed.");
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    if (err.code) console.error("CODE:", err.code);
  }
}

main();
