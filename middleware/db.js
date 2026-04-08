const { APP_VERSION } = require("../config/constants");
const state = require("../lib/state");

function requireDbReady(req, res, next) {
  if (!state.DB_READY) {
    return res.status(503).json({
      success: false,
      version: APP_VERSION,
      error: "DB not reachable. Check DATABASE_URL / network.",
    });
  }
  next();
}

function requireNotProduction(req, res, next) {
  const env = String(process.env.NODE_ENV || "").toLowerCase();
  if (env === "production") {
    return res.status(404).json({ success: false, version: APP_VERSION, error: "Not found" });
  }
  next();
}

module.exports = { requireDbReady, requireNotProduction };
