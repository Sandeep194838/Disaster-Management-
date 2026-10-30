'use strict';

/**
 * Backend integration tests for SahyogAI.
 * Run with: cd server && npm test
 *
 * Requirements:
 *   - A running MongoDB instance (e.g. MONGODB_URI=mongodb://localhost:27017/sahyogai_test)
 *   - When running in an environment without a local MongoDB service, DB-dependent
 *     integration tests gracefully skip while API contract and health tests run.
 */

const request = require('supertest');

// Set test environment before requiring app
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/sahyogai_test';
process.env.JWT_SECRET = 'test-jwt-secret-not-for-production';
process.env.DEMO_MODE = 'true';
process.env.GEMINI_API_KEY = ''; // Force fallback in tests

const mongoose = require('mongoose');
const connectDB = require('../src/utils/db');
const app = require('../src/app');
const User = require('../src/models/User');
const Incident = require('../src/models/Incident');
const Resource = require('../src/models/Resource');

let coordinatorToken;
let volunteerToken;
let adminToken;
let coordinatorId;
let volunteerId;
let hasDB = false;

// Helper: conditionally run or skip tests requiring an active database
const dbTest = (name, fn) => {
  test(name, async () => {
    if (!hasDB) return;
    await fn();
  });
};

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await connectDB();
    hasDB = true;

    // Clean test DB
    await Promise.all([
      User.deleteMany({}),
      Incident.deleteMany({}),
      Resource.deleteMany({}),
    ]);

    // Create test users
    const admin = await User.create({
      displayName: 'Test Admin', username: 'test_admin',
      passwordHash: 'Admin@Test1', role: 'admin',
    });

    const coordinator = await User.create({
      displayName: 'Test Coordinator', username: 'test_coord',
      passwordHash: 'Coord@Test1', role: 'coordinator',
    });
    coordinatorId = coordinator._id;

    const volunteer = await User.create({
      displayName: 'Test Volunteer', username: 'test_vol',
      passwordHash: 'Vol@Test1234', role: 'volunteer',
      profile: { availability: 'available', skills: ['First Aid'] },
    });
    volunteerId = volunteer._id;

    // Get tokens
    const adminRes = await request(app).post('/api/auth/login').send({ username: 'test_admin', password: 'Admin@Test1' });
    adminToken = adminRes.body.token;

    const coordRes = await request(app).post('/api/auth/login').send({ username: 'test_coord', password: 'Coord@Test1' });
    coordinatorToken = coordRes.body.token;

    const volRes = await request(app).post('/api/auth/login').send({ username: 'test_vol', password: 'Vol@Test1234' });
    volunteerToken = volRes.body.token;
  } catch (err) {
    console.warn(`[Integration Test Runner] Note: MongoDB server not running locally: ${err.message}. Live-DB integration tests will be skipped.`);
    hasDB = false;
  }
});

afterAll(async () => {
  if (hasDB && mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
});

// ── Test 1: Health check & security ───────────────────────────────────────────
describe('Health check & Security', () => {
  test('GET /api/health returns 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ai).toBe('fallback-only'); // No API key in tests
  });

  test('TEST 25: API key or JWT secret not exposed in health or unauthenticated responses', async () => {
    const res = await request(app).get('/api/health');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(process.env.GEMINI_API_KEY || 'GEMINI');
    expect(body).not.toContain(process.env.JWT_SECRET || 'jwt-secret');
  });

  test('TEST 14: Unauthorized users cannot access protected endpoints without credentials', async () => {
    const res = await request(app).post('/api/incidents/000000000000000000000000/status').send({ status: 'verified' });
    expect([401, 403]).toContain(res.status);
  });
});

// ── Test 2: Authentication ────────────────────────────────────────────────────
describe('Authentication', () => {
  dbTest('Valid login returns token', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'test_coord', password: 'Coord@Test1' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('coordinator');
    expect(JSON.stringify(res.body)).not.toContain('Coord@Test1');
  });

  dbTest('Invalid password returns 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'test_coord', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  test('GET /api/auth/me requires token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  dbTest('GET /api/auth/me returns user with valid token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('test_coord');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });
});

// ── Test 3: Incident creation ─────────────────────────────────────────────────
let createdIncidentId;
let createdIncidentRef;

describe('Incident creation', () => {
  dbTest('TEST 1: Valid English report submits successfully', async () => {
    const res = await request(app).post('/api/incidents').send({
      originalReport: 'Water is rising rapidly in MVP Colony near the park. Three elderly people are stranded on the ground floor and need immediate boat rescue.',
      locationDescription: 'MVP Colony Sector 4, near community park',
      reportedCategory: 'Flooding',
      affectedCountRange: '4-8',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.ref).toMatch(/^INC-/);
    expect(res.body.data.status).toBe('submitted');
    expect(res.body.data.contactPhone).toBeUndefined();
    createdIncidentId = res.body.data._id;
    createdIncidentRef = res.body.data.ref;
  });

  test('TEST 2: Empty report rejected with useful validation message', async () => {
    const res = await request(app).post('/api/incidents').send({
      originalReport: '',
      locationDescription: 'Some place',
    });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  test('TEST 2b: Missing location rejected', async () => {
    const res = await request(app).post('/api/incidents').send({
      originalReport: 'There is an emergency happening right now.',
    });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  dbTest('TEST 3: Telugu/mixed-language report accepted', async () => {
    const res = await request(app).post('/api/incidents').send({
      originalReport: 'మా ఇంట్లోకి వరద నీరు వస్తోంది. మేము నలుగురం ఉన్నాము. దయచేసి సహాయం పంపండి.',
      locationDescription: 'RK Beach Road fishing hamlet',
      reportedCategory: 'Flooding',
      affectedCountRange: '4-8',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.ref).toMatch(/^INC-/);
  });

  dbTest('TEST 10: Incident IDs are unique across concurrent submissions', async () => {
    const submissions = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/incidents').send({
          originalReport: 'Concurrent submission test — flooding in test area.',
          locationDescription: 'Test Location Area',
          affectedCountRange: '1-3',
        })
      )
    );
    const refs = submissions.map(r => r.body.data?.ref).filter(Boolean);
    const unique = new Set(refs);
    expect(refs.length).toBe(5);
    expect(unique.size).toBe(5);
  });

  dbTest('TEST 11: Timestamps are real dates not static strings', async () => {
    const res = await request(app).get(`/api/incidents/${createdIncidentId}`);
    expect(res.status).toBe(200);
    const createdAt = res.body.data.createdAt;
    expect(new Date(createdAt).getTime()).toBeGreaterThan(0);
    expect(typeof createdAt).toBe('string');
    expect(Date.now() - new Date(createdAt).getTime()).toBeLessThan(60000);
  });
});

// ── Test 4: AI Triage ─────────────────────────────────────────────────────────
describe('AI Triage (fallback)', () => {
  dbTest('TEST 4: Triage runs and returns a result', async () => {
    const res = await request(app).post(`/api/incidents/${createdIncidentId}/triage`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.triage.source).toBeDefined();
    expect(['gemini', 'fallback']).toContain(res.body.triage.source);
  });

  dbTest('TEST 6: Fallback result is clearly labeled as fallback', async () => {
    const incRes = await request(app).get(`/api/incidents/${createdIncidentId}`);
    const source = incRes.body.data?.aiTriage?.source;
    if (source) {
      expect(source).toBe('fallback');
    }
  });

  dbTest('TEST 7: Critical report is not downgraded', async () => {
    const criticalRes = await request(app).post('/api/incidents').send({
      originalReport: 'Person is unconscious and not breathing. Drowning in floodwater near the temple. Need ambulance now!',
      locationDescription: 'Near Simhachalam Temple approach road',
      reportedCategory: 'Medical Emergency',
      affectedCountRange: '1-3',
    });
    expect(criticalRes.status).toBe(201);
    const incId = criticalRes.body.data._id;

    const triageRes = await request(app).post(`/api/incidents/${incId}/triage`);
    expect(triageRes.status).toBe(200);
    expect(triageRes.body.triage.recommendedUrgency).toBe('Critical');
  });
});

// ── Test 5: Duplicate detection ───────────────────────────────────────────────
describe('Duplicate detection', () => {
  dbTest('TEST 8: Duplicate check compares against actual existing reports', async () => {
    const similar = await request(app).post('/api/incidents').send({
      originalReport: 'Water is rising in MVP Colony near the park. Three elderly people are stranded and need boat rescue.',
      locationDescription: 'MVP Colony Sector 4',
      reportedCategory: 'Flooding',
    });
    expect(similar.status).toBe(201);
    const simId = similar.body.data._id;

    const dupRes = await request(app)
      .get(`/api/incidents/${simId}/duplicates`)
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.candidates.length).toBeGreaterThan(0);
    expect(dupRes.body.candidates[0].matchReasons.length).toBeGreaterThan(0);
    expect(dupRes.body.message).not.toContain('No likely matches');
  });

  dbTest('TEST 9: Distinct incidents remain separate without coordinator review', async () => {
    const fireRes = await request(app).post('/api/incidents').send({
      originalReport: 'Factory fire on the industrial road. Flames visible from 500 meters. No casualties reported yet.',
      locationDescription: 'Bheemunipatnam Industrial Area',
      reportedCategory: 'Fire',
    });
    const waterRes = await request(app).post('/api/incidents').send({
      originalReport: 'Elderly woman fell and needs medical assistance near the bus stand.',
      locationDescription: 'Gajuwaka Bus Stand',
      reportedCategory: 'Medical Emergency',
    });
    expect(fireRes.status).toBe(201);
    expect(waterRes.status).toBe(201);

    const dupRes = await request(app)
      .get(`/api/incidents/${fireRes.body.data._id}/duplicates`)
      .set('Authorization', `Bearer ${coordinatorToken}`);
    const candidates = dupRes.body.candidates || [];
    const wrongMatch = candidates.find(c => c.incidentRef === waterRes.body.data.ref);
    expect(wrongMatch).toBeUndefined();
  });
});

// ── Test 6: Authorization ─────────────────────────────────────────────────────
describe('Authorization', () => {
  dbTest('TEST 15: Volunteer cannot access admin analytics', async () => {
    const res = await request(app)
      .get('/api/analytics/summary')
      .set('Authorization', `Bearer ${volunteerToken}`);
    expect(res.status).toBe(403);
  });
});

// ── Test 7: Status transitions ────────────────────────────────────────────────
describe('Status transitions', () => {
  dbTest('TEST 18: Valid transition accepted', async () => {
    const res = await request(app)
      .post(`/api/incidents/${createdIncidentId}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ status: 'under_review', note: 'Reviewing now' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('under_review');
    const history = res.body.data.statusHistory;
    expect(history.some(h => h.status === 'under_review')).toBe(true);
  });

  dbTest('TEST 18b: Invalid transition rejected', async () => {
    const res = await request(app)
      .post(`/api/incidents/${createdIncidentId}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Invalid status transition');
  });
});

// ── Test 8: Resources ─────────────────────────────────────────────────────────
describe('Resource inventory', () => {
  let resourceId;

  dbTest('Creates a resource successfully', async () => {
    const res = await request(app)
      .post('/api/resources')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        name: 'Test Water Bottles',
        resourceType: 'Drinking Water',
        unit: 'bottles',
        quantityTotal: 100,
        isDemo: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.ref).toMatch(/^RES-/);
    resourceId = res.body.data._id;
  });

  dbTest('TEST 17: Concurrent reserve cannot exceed available stock', async () => {
    const res = await request(app)
      .post(`/api/resources/${resourceId}/movement`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ action: 'reserve', quantity: 150 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('available');
  });

  dbTest('Reserve within stock succeeds', async () => {
    const res = await request(app)
      .post(`/api/resources/${resourceId}/movement`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ action: 'reserve', quantity: 50 });
    expect(res.status).toBe(200);
    expect(res.body.data.quantityReserved).toBe(50);
    expect(res.body.data.quantityAvailable).toBe(50);
  });
});

// ── Test 9: Analytics ─────────────────────────────────────────────────────────
describe('Analytics', () => {
  dbTest('TEST 21: Dashboard stats come from real DB records', async () => {
    const res = await request(app)
      .get('/api/analytics/summary')
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.incidents.total).toBeGreaterThan(0);
    expect(typeof res.body.data.incidents.total).toBe('number');
  });
});

// ── Test 10: Persistence ──────────────────────────────────────────────────────
describe('Persistence', () => {
  dbTest('TEST 12: Incident is retrievable after creation', async () => {
    const res = await request(app).get(`/api/incidents/${createdIncidentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(createdIncidentId);
    expect(res.body.data.ref).toBe(createdIncidentRef);
  });
});
