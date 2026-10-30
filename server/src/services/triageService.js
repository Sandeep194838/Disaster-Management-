'use strict';

/**
 * AI Triage Service
 * -----------------
 * Calls the Gemini API (server-side) with a strict JSON schema.
 * Falls back transparently to a deterministic rule-based engine.
 * NEVER exposes the API key to the client.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { URGENCY_LEVELS, CATEGORIES } = require('../models/Incident');

const TIMEOUT_MS = 12000; // 12-second hard limit

// ── Strict output schema for AI ─────────────────────────────────────────────
const SCHEMA_EXAMPLE = {
  recommendedUrgency: 'Critical | High | Medium | Low',
  recommendedCategory: '<one of the valid categories>',
  incidentTitle: '<4-6 word title>',
  summary: '<1-2 sentence dispatch brief>',
  affectedCount: '<number or null>',
  immediateNeeds: ['<need 1>', '<need 2>'],
  hazards: ['<hazard 1>'],
  recommendedNextSteps: ['<step 1>', '<step 2>'],
  missingInfo: ['<info 1>'],
  confidence: 'high | medium | low | uncertain',
  reasoning: '<brief explanation of urgency recommendation>',
  detectedLanguage: 'en | te | mixed | unknown',
};

const SYSTEM_PROMPT = `You are SahyogAI, a disaster emergency triage AI deployed in Visakhapatnam, Andhra Pradesh, India.
You assist trained emergency coordinators — you do NOT replace them.

Your task is to analyze an incoming emergency SOS report and return a structured JSON triage assessment.

URGENCY LEVELS (choose one):
- Critical: Immediate threat to life, severe injury, people trapped, drowning, cardiac emergency, fire, imminent structural collapse.
- High: Significant risk, deteriorating situation, vulnerable populations (elderly, infants, pregnant), essential medical needs.
- Medium: Serious but stable situation, essential supplies shortage, infrastructure damage without immediate life threat.
- Low: Minor damage or inconvenience, no reported injuries, informational reports.

SAFETY RULES:
- Do NOT downgrade urgency solely because a keyword is absent.
- Treat reports of trapped people, blood, unconsciousness, drowning, fire, or imminent collapse as at least High urgency.
- If uncertain, lean toward higher urgency and set confidence to "uncertain".
- Do NOT invent names, locations, injuries, or numbers not stated in the report.
- If the report is in Telugu or Tanglish, understand the meaning — do not transliterate blindly.
- Preserve original text in summary if translation is uncertain.

VALID CATEGORIES: ${CATEGORIES.join(' | ')}

Respond with ONLY a valid JSON object matching this exact schema (no markdown, no code fences):
${JSON.stringify(SCHEMA_EXAMPLE, null, 2)}`;

// ── Validation: check AI output before using it ─────────────────────────────
function validateAIOutput(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!URGENCY_LEVELS.includes(obj.recommendedUrgency)) return false;
  if (typeof obj.summary !== 'string' || obj.summary.length < 5) return false;
  if (!['high', 'medium', 'low', 'uncertain'].includes(obj.confidence)) return false;
  return true;
}

function sanitizeAIOutput(obj) {
  return {
    recommendedUrgency: URGENCY_LEVELS.includes(obj.recommendedUrgency) ? obj.recommendedUrgency : 'Medium',
    recommendedCategory: CATEGORIES.includes(obj.recommendedCategory) ? obj.recommendedCategory : null,
    incidentTitle: typeof obj.incidentTitle === 'string' ? obj.incidentTitle.slice(0, 100) : null,
    summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 1000) : '',
    affectedCount: typeof obj.affectedCount === 'number' && obj.affectedCount >= 0 ? Math.floor(obj.affectedCount) : null,
    immediateNeeds: Array.isArray(obj.immediateNeeds) ? obj.immediateNeeds.map(String).slice(0, 10) : [],
    hazards: Array.isArray(obj.hazards) ? obj.hazards.map(String).slice(0, 10) : [],
    recommendedNextSteps: Array.isArray(obj.recommendedNextSteps) ? obj.recommendedNextSteps.map(String).slice(0, 8) : [],
    missingInfo: Array.isArray(obj.missingInfo) ? obj.missingInfo.map(String).slice(0, 6) : [],
    confidence: ['high', 'medium', 'low', 'uncertain'].includes(obj.confidence) ? obj.confidence : 'uncertain',
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 1000) : '',
    detectedLanguage: ['en', 'te', 'mixed', 'unknown'].includes(obj.detectedLanguage) ? obj.detectedLanguage : 'unknown',
  };
}

// ── Rule-based fallback ──────────────────────────────────────────────────────
function ruleFallback(reportText, location, userCategory, affectedCountRange) {
  const lower = reportText.toLowerCase();

  // Critical triggers
  const criticalPatterns = [
    'trapped', 'trap', 'unconscious', 'not breathing', 'heart attack', 'cardiac',
    'drowning', 'drown', 'bleeding heavily', 'blood', 'fire', 'burning', 'burn',
    'collapse', 'collapsed', 'labor', 'labour', 'childbirth', 'ambulance',
    'critical', 'dying', 'died', 'dead', 'terrace', 'rooftop stranded',
    // Telugu/Tanglish
    'neellu', 'velu', 'water rising', 'munchaindi', 'chanipoindi', 'gaayam',
    'rescue cheyyandi', 'help send', 'urgent', 'emergency', 'boat pampandi',
    'boat send', 'immediately',
  ];
  const highPatterns = [
    'water', 'flood', 'flooded', 'inundation', 'elderly', 'senior', 'infant',
    'baby', 'pregnant', 'diabetic', 'insulin', 'medicine', 'bp medicine',
    'no food', 'no water', 'drinking water', 'shelter needed', 'roof damaged',
    'power cut', 'no electricity', 'varda', 'cyclone', 'missing',
    'varadu', 'neellu vastunnai', 'help', 'save',
  ];

  const hasCritical = criticalPatterns.some(p => lower.includes(p));
  const hasHigh = highPatterns.some(p => lower.includes(p));

  let urgency = 'Medium';
  if (hasCritical) urgency = 'Critical';
  else if (hasHigh || userCategory === 'Medical Emergency') urgency = 'High';
  else if (userCategory === 'Food & Drinking Water' || userCategory === 'Shelter') urgency = 'Medium';
  else urgency = 'Low';

  // Category detection
  let category = userCategory;
  if (!CATEGORIES.includes(category)) {
    if (lower.includes('water') || lower.includes('flood')) category = 'Flooding';
    else if (lower.includes('fire') || lower.includes('burn')) category = 'Fire';
    else if (lower.includes('trapped') || lower.includes('missing')) category = 'Trapped / Missing People';
    else if (lower.includes('food') || lower.includes('water') || lower.includes('ration')) category = 'Food & Drinking Water';
    else category = 'Other Emergency';
  }

  // Immediate needs
  const needs = [];
  if (lower.includes('boat')) needs.push('Rescue boat');
  if (lower.includes('insulin') || lower.includes('medicine') || lower.includes('bp')) needs.push('Medicines / Medical kit');
  if (lower.includes('food') || lower.includes('ration')) needs.push('Food supplies');
  if (lower.includes('water')) needs.push('Drinking water');
  if (lower.includes('shelter') || lower.includes('roof')) needs.push('Temporary shelter');
  if (lower.includes('ambulance') || lower.includes('hospital')) needs.push('Medical transport');
  if (needs.length === 0) needs.push('Emergency assessment');

  // Language detection
  const teluguChars = /[\u0C00-\u0C7F]/;
  const hasEnglish = /[a-zA-Z]/.test(reportText);
  const hasTelugu = teluguChars.test(reportText);
  let lang = 'unknown';
  if (hasTelugu && hasEnglish) lang = 'mixed';
  else if (hasTelugu) lang = 'te';
  else if (hasEnglish) lang = 'en';

  const summary = `Emergency reported at ${location}. ${reportText.slice(0, 120)}${reportText.length > 120 ? '...' : ''}`;
  const title = `${category.split('/')[0].trim()} — ${location.split(',')[0].trim()}`.slice(0, 80);

  return {
    recommendedUrgency: urgency,
    recommendedCategory: category,
    incidentTitle: title,
    summary,
    affectedCount: null,
    immediateNeeds: needs,
    hazards: hasCritical ? ['Potential life-threatening situation reported'] : [],
    recommendedNextSteps: [
      'Coordinator to verify incident details by phone or field contact.',
      'Dispatch nearest available response team if urgency is confirmed.',
    ],
    missingInfo: [
      'Exact number of people affected not confirmed.',
      'Current physical condition of affected persons unknown.',
    ],
    confidence: 'low',
    reasoning: `Rule-based fallback classification. Category: ${category}. Urgency set to ${urgency} based on keyword analysis. AI service was unavailable — coordinator review is essential.`,
    detectedLanguage: lang,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────
async function runTriage({ reportText, location, userCategory, affectedCountRange }) {
  const startMs = Date.now();

  // Attempt Gemini call only if key is configured
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      });

      const userPrompt = `Location: "${location}"
Reported category: "${userCategory || 'Not specified'}"
Estimated people affected: "${affectedCountRange || 'Unknown'}"
Emergency report (may be in English, Telugu, or mixed):
"""
${reportText}
"""`;

      // Apply timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini API timeout')), TIMEOUT_MS)
      );

      const resultPromise = model.generateContent([SYSTEM_PROMPT, userPrompt]);
      const result = await Promise.race([resultPromise, timeoutPromise]);

      const rawText = result.response.text();
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (_e) {
        // Try extracting JSON from potential prose wrapper
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('Gemini returned non-JSON response');
      }

      if (!validateAIOutput(parsed)) {
        throw new Error('Gemini output failed schema validation');
      }

      const sanitized = sanitizeAIOutput(parsed);
      return {
        ...sanitized,
        source: 'gemini',
        model: 'gemini-1.5-flash',
        processedAt: new Date(),
        processingMs: Date.now() - startMs,
        rawResponse: parsed,
      };

    } catch (err) {
      console.warn('[TriageService] Gemini failed, using rule-based fallback:', err.message);
    }
  }

  // Deterministic fallback
  const fallback = ruleFallback(reportText, location, userCategory, affectedCountRange);
  return {
    ...fallback,
    source: 'fallback',
    model: 'rule-based-v1',
    processedAt: new Date(),
    processingMs: Date.now() - startMs,
    rawResponse: null,
  };
}

module.exports = { runTriage };

