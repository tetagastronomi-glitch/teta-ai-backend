/**
 * TE TA AI - SISTEMI HIBRID (OpenAI + Ollama Ready)
 * Versioni: v-2026-02-04-hybrid-power
 */

require("dotenv").config({ override: true });
process.env.TZ = "Europe/Tirane";

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ==================== KONFIGURIMI I STRATEGJISË AI ====================
// Ndryshoje në "ollama" nëse dëshiron pavarësi të plotë në të ardhmen
const AI_STRATEGY = process.env.AI_STRATEGY || "openai"; 

// ==================== FUNKSIONI TRU (AI ENGINE) ====================
async function merrPergjigjeNgaAI(tekstiKlientit) {
  try {
    if (AI_STRATEGY === "openai") {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini", // Kursim maksimal dhe shpejtësi
          messages: [
            { role: "system", content: "Ti je Te Ta AI, një asistent profesionist për menaxhimin e bisedave në shqip." },
            { role: "user", content: tekstiKlientit }
          ],
        },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
      );
      return res.data.choices[0].message.content;
    } 

    if (AI_STRATEGY === "ollama") {
      // Kjo do të punojë kur të kesh serverin tënd privat
      const res = await axios.post("http://localhost:11434/api/generate", {
        model: "llama3",
        prompt: tekstiKlientit,
        stream: false
      });
      return res.data.response;
    }
  } catch (err) {
    console.error("❌ Gabim në AI Engine:", err.message);
    return "Më falni, sistemi po përballet me një ngarkesë. Provojeni përsëri pas pak.";
  }
}

// ==================== WEBHOOK PËR WHATSAPP (META) ====================

// 1. Verifikimi (Gjatë setup-it në Meta Dashboard)
app.get("/webhook", (req, res) => {
  const verify_token = "te_ta_ai_2026";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("✅ Webhook u verifikua nga Meta!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2. Marrja dhe Përpunimi i Mesazhit
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const customerText = message.text.body;

      console.log(`📩 Mesazh nga ${from}: ${customerText}`);

      // Merr përgjigjen nga Inteligjenca Artificiale (Hibride)
      const aiResponse = await merrPergjigjeNgaAI(customerText);

      try {
        // Dërgo përgjigjen mbrapsht në WhatsApp
        await axios({
          method: "POST",
          url: `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          data: {
            messaging_product: "whatsapp",
            to: from,
            text: { body: aiResponse },
          },
          headers: {
            "Authorization": `Bearer ${process.env.WA_TOKEN}`,
            "Content-Type": "application/json"
          },
        });
        console.log("✅ Përgjigjja u dërgua!");
      } catch (err) {
        console.error("❌ Gabim në WhatsApp Send:", err.response?.data || err.message);
      }
    }
    return res.sendStatus(200);
  }
  res.sendStatus(404);
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  🚀 SERVERI ONLINE
  📡 Porti: ${PORT}
  🧠 Strategjia AI: ${AI_STRATEGY.toUpperCase()}
  🛠️ Versioni: v-2026-02-04
  `);
});