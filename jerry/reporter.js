// jerry/reporter.js
// Dërgon mesazhe WhatsApp tek pronari i platformës (Gerald) via Meta Cloud API

const axios = require('axios');

const WA_PLATFORM_TOKEN = process.env.WA_PLATFORM_TOKEN;
const WA_PHONE_ID       = process.env.WA_PHONE_ID;
const OWNER_PHONE       = process.env.OWNER_PHONE;

async function sendWhatsApp(body) {
  if (!WA_PLATFORM_TOKEN || !WA_PHONE_ID || !OWNER_PHONE) {
    console.warn('[Jerry] Reporter: WA env variables missing, skipping message');
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: OWNER_PHONE,
        type: 'text',
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_PLATFORM_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );
  } catch (err) {
    console.error('[Jerry] sendWhatsApp error:', err.message);
  }
}

async function sendAlert(anomaly, analysis) {
  const body =
    `⚠️ *JERRY ALERT*\n` +
    `Problemi: ${anomaly.description}\n` +
    `Shkaku: ${analysis.cause}\n` +
    `Veprimi: ${analysis.action}\n` +
    `Serioziteti: ${anomaly.severity}/10`;
  await sendWhatsApp(body);
}

async function sendResolved(incident, durationSeconds) {
  const body =
    `✅ *JERRY — U ZGJIDH*\n` +
    `Problemi: ${incident.type}\n` +
    `Zgjidhja: ${incident.action_taken}\n` +
    `Kohëzgjatja: ${durationSeconds} sekonda`;
  await sendWhatsApp(body);
}

async function sendDailyReport(stats) {
  const body =
    `📊 *JERRY — RAPORTI DITOR*\n` +
    `─────────────\n` +
    `Uptime: ${stats.uptime}%\n` +
    `Incidente: ${stats.incidents} (${stats.resolved} zgjidhur)\n` +
    `Rezervime sot: ${stats.reservations_today}\n` +
    `Klientë aktivë: ${stats.active_customers}\n` +
    `─────────────\n` +
    `${stats.prediction}`;
  await sendWhatsApp(body);
}

module.exports = { sendAlert, sendResolved, sendDailyReport };
