const express = require("express");
const router = express.Router();

router.get("/webhook", (req, res) => {
  const verify_token = "te_ta_ai_2026";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("✅ WEBHOOK_VERIFIED_BY_META");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

router.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const customerText = message.text.body;
      // FIX #1: Vetëm log — auto-reply DISABLED deri në n8n integration
      console.log(`📩 Mesazh i ri nga ${from}: ${customerText}`);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(404);
});

module.exports = router;
