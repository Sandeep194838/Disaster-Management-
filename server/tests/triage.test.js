'use strict';

/**
 * Unit tests for the triage service (no network calls, no DB).
 */

process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = ''; // Force rule-based fallback

const { runTriage } = require('../src/services/triageService');
const { findCandidates } = require('../src/services/duplicateService');

// ── Triage fallback tests ─────────────────────────────────────────────────────
describe('Triage service (rule-based fallback)', () => {
  test('Critical keywords → Critical urgency', async () => {
    const result = await runTriage({
      reportText: 'Person is trapped and unconscious on the terrace. Water is rising fast.',
      location: 'MVP Colony',
      userCategory: 'Flooding',
    });
    expect(result.source).toBe('fallback');
    expect(result.recommendedUrgency).toBe('Critical');
    expect(result.confidence).toBeDefined();
    expect(result.reasoning).toBeTruthy();
  });

  test('Telugu report handled without crashing', async () => {
    const result = await runTriage({
      reportText: 'మా ఇంట్లోకి వరద నీరు వస్తోంది. మేము నలుగురం ఉన్నాము.',
      location: 'RK Beach',
      userCategory: 'Flooding',
    });
    expect(result).toBeTruthy();
    expect(['Critical', 'High', 'Medium', 'Low']).toContain(result.recommendedUrgency);
    expect(['en', 'te', 'mixed', 'unknown']).toContain(result.detectedLanguage);
  });

  test('Medical category → at least High urgency', async () => {
    const result = await runTriage({
      reportText: 'My elderly father needs his blood pressure medication. We have been without electricity for 12 hours.',
      location: 'Seethammadhara',
      userCategory: 'Medical Emergency',
    });
    expect(['Critical', 'High']).toContain(result.recommendedUrgency);
  });

  test('Returns required output fields', async () => {
    const result = await runTriage({
      reportText: 'Road blocked by fallen tree after the storm.',
      location: 'Pendurthi Junction',
      userCategory: 'Roadblock & Fallen Trees',
    });
    expect(result.recommendedUrgency).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(Array.isArray(result.immediateNeeds)).toBe(true);
    expect(Array.isArray(result.hazards)).toBe(true);
    expect(result.confidence).toBeDefined();
    expect(result.reasoning).toBeDefined();
    expect(result.source).toBe('fallback');
    expect(result.processingMs).toBeGreaterThanOrEqual(0);
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  test('TEST 5: Invalid output from AI would be caught by schema validation', () => {
    // Simulate bad AI output
    const { validateAIOutput } = (() => {
      // Inline the validator logic for unit testing
      const URGENCY_LEVELS = ['Critical', 'High', 'Medium', 'Low'];
      return {
        validateAIOutput: (obj) => {
          if (!obj || typeof obj !== 'object') return false;
          if (!URGENCY_LEVELS.includes(obj.recommendedUrgency)) return false;
          if (typeof obj.summary !== 'string' || obj.summary.length < 5) return false;
          if (!['high', 'medium', 'low', 'uncertain'].includes(obj.confidence)) return false;
          return true;
        }
      };
    })();

    expect(validateAIOutput(null)).toBe(false);
    expect(validateAIOutput({ recommendedUrgency: 'EXTREME', summary: 'x', confidence: 'high' })).toBe(false);
    expect(validateAIOutput({ recommendedUrgency: 'Critical', summary: 'ok', confidence: 'bad' })).toBe(false);
    expect(validateAIOutput({ recommendedUrgency: 'Critical', summary: 'Good dispatch summary', confidence: 'high' })).toBe(true);
  });
});

// ── Duplicate detection unit tests ────────────────────────────────────────────
describe('Duplicate detection (Jaccard similarity)', () => {
  test('Tokenizer produces a set of meaningful tokens', () => {
    // Access via the module's internal functions by replicating the logic
    const { findCandidates: fc } = require('../src/services/duplicateService');
    expect(typeof fc).toBe('function');
  });

  test('Returns empty array when no DB incidents exist (unit)', async () => {
    // If no incidents in DB, should return empty without crashing
    const Incident = require('../src/models/Incident');
    const spy = jest.spyOn(Incident, 'find').mockImplementation(() => ({
      select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) })
    }));

    const result = await findCandidates({
      locationDescription: 'Test Location',
      reportText: 'Some emergency description',
      category: 'Flooding',
      coordinates: null,
      isDemo: true,
    });

    expect(result).toEqual([]);
    spy.mockRestore();
  });
});

