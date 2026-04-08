const express = require("express");
const router = express.Router();
const path = require("path");
const axios = require("axios");
const { requireAdminKey } = require("../middleware/auth");

router.get('/admin-panel', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

router.get('/command', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'command.html'));
});

router.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

router.get('/platform', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'platform.html'));
});

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

router.get('/onboarding', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'onboarding.html'));
});

// All dashboard sub-pages
router.get('/guests', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'guests.html'));
});
router.get('/analytics', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'analytics.html'));
});
router.get('/messages', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'messages.html'));
});
router.get('/settings', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
});
router.get('/campaigns', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'campaigns.html'));
});
router.get('/menu', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'menu.html'));
});
router.get('/floorplan', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'floorplan.html'));
});
router.get('/waitlist', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'waitlist.html'));
});
router.get('/demo', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
});
router.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

router.get('/test-wa', requireAdminKey, async (_req, res) => {
  try {
    const r = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${process.env.WA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        to: '355697918181',
        type: 'text',
        text: { body: 'Test nga Te Ta AI - sistemi punon!' }
      }
    });
    return res.json({ ok: true, data: r.data });
  } catch(e) {
    return res.json({ ok: false, error: e.response?.data || e.message });
  }
});

router.get('/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Te Ta AI - Privacy</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
<h1>Te Ta AI — Privacy Policy</h1>
<p>Te Ta AI është platformë për menaxhimin e rezervimeve dhe klientëve për bizneset e hotelërisë.</p>
<h2>Të dhënat që ruajmë</h2>
<p>Emri, numri i telefonit, dhe historiku i rezervimeve të klientëve.</p>
<h2>Si i përdorim</h2>
<p>Vetëm për qëllime operacionale të biznesit. Nuk shpërndahen me palë të treta.</p>
<h2>Kontakt</h2>
<p>gerikurtina@gmail.com</p>
</body></html>`);
});

module.exports = router;
