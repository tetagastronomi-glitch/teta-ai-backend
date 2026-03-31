// jerry/intelligence.js
// Anomaly analysis via Claude — returns cause, action, canSelfHeal, ownerMessage

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeAnomaly(anomaly, recentIncidents, memory) {
  const prompt = `
Anomalia: ${anomaly.type}
Përshkrimi: ${anomaly.description}
Serioziteti: ${anomaly.severity}/10
Vlera: ${anomaly.value}

Incidentet e fundit (7 ditë): ${JSON.stringify(recentIncidents.slice(0, 5))}
Kujtesa ime: ${JSON.stringify(memory.slice(0, 3))}

Analizo dhe jep:
1. Shkaku i mundshëm (1 fjali)
2. Veprimi i rekomanduar (1 fjali)
3. A mund ta zgjidhë Jerry vetë? (po/jo)
4. Mesazhi për pronarin (max 3 rreshta, WhatsApp-friendly)

Formato si JSON:
{
  "cause": string,
  "action": string,
  "canSelfHeal": boolean,
  "ownerMessage": string
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: 'Ti je Jerry — agjenti inteligjent i Te Ta AI, një platformë rezervimesh për restorante shqiptare. Analizon anomali dhe jep rekomandime konkrete dhe të shkurtra. Përgjigju GJITHMONË në shqip. Ji i qartë dhe i drejtë.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('No JSON found in response');
  } catch (err) {
    console.error('[Jerry] intelligence error:', err.message);
    return {
      cause: 'Shkaku i panjohur — analiza dështoi',
      action: 'Kontroll manual i rekomanduar',
      canSelfHeal: false,
      ownerMessage: `⚠️ Jerry zbuloi: ${anomaly.description}\nSerioziteti: ${anomaly.severity}/10\nKërkohet vëmendje.`,
    };
  }
}

module.exports = { analyzeAnomaly };
