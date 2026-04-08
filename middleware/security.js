const rateLimit = require("express-rate-limit");

const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Shumë kërkesa. Provo pas 15 minutash." },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Shumë kërkesa. Provo pas pak sekondash." },
});

const ownerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Shumë kërkesa nga paneli." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Shumë tentativa login. Provo pas 15 minutash." },
});

module.exports = { reservationLimiter, generalLimiter, ownerLimiter, loginLimiter };
