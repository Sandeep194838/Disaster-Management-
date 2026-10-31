'use strict';

const express = require('express');
const Incident = require('../models/Incident');
const User = require('../models/User');
const Resource = require('../models/Resource');
const Assignment = require('../models/Assignment');
const AuditEvent = require('../models/AuditEvent');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, createError } = require('../middleware/errorHandler');

const router = express.Router();

// ============================================================================
// POST /api/demo/reset — reset all demo data (admin/coordinator only)
// Requires explicit confirmation token to prevent accidental resets
// ============================================================================
router.post('/reset', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET_DEMO_DATA') {
    throw createError('Provide { "confirm": "RESET_DEMO_DATA" } to confirm reset.', 422);
  }

  // Delete only demo-flagged records
  await Promise.all([
    Incident.deleteMany({ isDemo: true }),
    Assignment.deleteMany({ isDemo: true }),
    Resource.deleteMany({ isDemo: true }),
    AuditEvent.deleteMany({ isDemo: true }),
    User.deleteMany({ isDemo: true, role: { $ne: 'admin' } }), // never delete demo admin
  ]);

  // Re-seed demo data
  await seedDemoData(req.user);

  res.json({ success: true, message: 'Demo data has been reset to the default Visakhapatnam scenario.' });
}));

// ============================================================================
// GET /api/demo/status — check if demo mode is active
// ============================================================================
router.get('/status', (_req, res) => {
  res.json({
    success: true,
    demoMode: process.env.DEMO_MODE === 'true',
    message: 'This is a demonstration environment. All data labeled DEMO is fictional.',
  });
});

// ============================================================================
// Seed function
// ============================================================================
async function seedDemoData(seedUser) {
  const seeder = seedUser || { _id: null, displayName: 'System Seed', role: 'admin' };

  // Demo volunteers
  const volunteerData = [
    {
      displayName: 'Kiran (AU NSS)',
      username: 'kiran_nss',
      passwordHash: 'Demo@2024!',
      role: 'volunteer',
      isDemo: true,
      profile: { skills: ['First Aid', 'Rescue'], serviceArea: 'MVP Colony, Seethammadhara', availability: 'available', teamAffiliation: 'AU NSS Cell' },
    },
    {
      displayName: 'Priya (Red Cross)',
      username: 'priya_redcross',
      passwordHash: 'Demo@2024!',
      role: 'volunteer',
      isDemo: true,
      profile: { skills: ['Medical', 'First Aid'], serviceArea: 'Dabagardens, Akkayyapalem', availability: 'available', teamAffiliation: 'Red Cross Student Cell' },
    },
    {
      displayName: 'Team Delta (Rescue Cell)',
      username: 'team_delta',
      passwordHash: 'Demo@2024!',
      role: 'volunteer',
      isDemo: true,
      profile: { skills: ['Boat Operation', 'Water Rescue', 'Heavy Equipment'], serviceArea: 'Gajuwaka, Old Town', availability: 'available', teamAffiliation: 'Vizag Rescue Cell' },
    },
    {
      displayName: 'Team Braver (4x4 Club)',
      username: 'team_braver',
      passwordHash: 'Demo@2024!',
      role: 'volunteer',
      isDemo: true,
      profile: { skills: ['Off-road Transport', 'Patient Transfer'], serviceArea: 'Pithapuram Colony, Maddilapalem', availability: 'available', teamAffiliation: 'Vizag 4x4 Club' },
    },
  ];
  const volunteers = [];
  for (const volunteerDataItem of volunteerData) {
    let volunteer = await User.findOne({ username: volunteerDataItem.username });
    if (!volunteer) volunteer = await User.create(volunteerDataItem);
    volunteers.push(volunteer);
  }

  // Demo resources
  const resourceData = [
    { name: 'Packaged Drinking Water (1L bottles)', resourceType: 'Drinking Water', unit: 'bottles', quantityTotal: 500, quantityReserved: 25, quantityDispatched: 80, storageLocation: 'GVMC Warehouse, Jagadamba Jn', responsibleOrg: 'GVMC Relief Cell', lowStockThreshold: 50 },
    { name: 'Ready-to-eat Food Packets', resourceType: 'Food Packets', unit: 'packets', quantityTotal: 300, quantityReserved: 30, quantityDispatched: 50, storageLocation: 'AU Community Center', responsibleOrg: 'Andhra University NSS', lowStockThreshold: 30 },
    { name: 'First-aid Kits (standard)', resourceType: 'First-Aid Kits', unit: 'kits', quantityTotal: 80, quantityReserved: 8, quantityDispatched: 20, storageLocation: 'King George Hospital Store', responsibleOrg: 'KGH Emergency Dept', lowStockThreshold: 10 },
    { name: 'Inflatable Rescue Boats', resourceType: 'Boats', unit: 'boats', quantityTotal: 5, quantityReserved: 1, quantityDispatched: 2, storageLocation: 'Port Area Depot', responsibleOrg: 'NDRF Team Vizag', lowStockThreshold: 1 },
    { name: 'Woolen Blankets', resourceType: 'Blankets', unit: 'blankets', quantityTotal: 200, quantityReserved: 20, quantityDispatched: 60, storageLocation: 'RTC Complex Hall', responsibleOrg: 'District Collector Office', lowStockThreshold: 20 },
    { name: 'Essential Medicines Kit', resourceType: 'Medicines', unit: 'kits', quantityTotal: 60, quantityReserved: 5, quantityDispatched: 15, storageLocation: 'PHC Akkayyapalem', responsibleOrg: 'Dept. of Health AP', lowStockThreshold: 5 },
  ];
  const legacyDemoTotals = {
    'Packaged Drinking Water (1L bottles)': 500,
    'Ready-to-eat Food Packets': 300,
    'First-aid Kits (standard)': 80,
    'Inflatable Rescue Boats': 5,
    'Woolen Blankets': 200,
  };
  const resources = [];
  for (const resourceDataItem of resourceData) {
    let resource = await Resource.findOne({ name: resourceDataItem.name, isDemo: true });
    if (!resource) {
      resource = await Resource.create({
        ...resourceDataItem,
        isDemo: true,
        movementHistory: [
          { action: 'stock_added', quantity: resourceDataItem.quantityTotal, byUser: seeder._id, byUserName: seeder.displayName, note: 'Initial demo inventory' },
          ...(resourceDataItem.quantityReserved ? [{ action: 'reserved', quantity: resourceDataItem.quantityReserved, byUser: seeder._id, byUserName: seeder.displayName, note: 'Seeded demo allocation' }] : []),
          ...(resourceDataItem.quantityDispatched ? [{ action: 'dispatched', quantity: resourceDataItem.quantityDispatched, byUser: seeder._id, byUserName: seeder.displayName, note: 'Seeded demo dispatch' }] : []),
        ],
      });
    } else if (
      legacyDemoTotals[resourceDataItem.name] === resource.quantityTotal
      && resource.quantityReserved === 0
      && resource.quantityDispatched === 0
      && resource.movementHistory.length === 0
    ) {
      Object.assign(resource, resourceDataItem, {
        movementHistory: [
          { action: 'stock_added', quantity: resourceDataItem.quantityTotal, byUser: seeder._id, byUserName: seeder.displayName, note: 'Initial demo inventory' },
          ...(resourceDataItem.quantityReserved ? [{ action: 'reserved', quantity: resourceDataItem.quantityReserved, byUser: seeder._id, byUserName: seeder.displayName, note: 'Seeded demo allocation' }] : []),
          ...(resourceDataItem.quantityDispatched ? [{ action: 'dispatched', quantity: resourceDataItem.quantityDispatched, byUser: seeder._id, byUserName: seeder.displayName, note: 'Seeded demo dispatch' }] : []),
        ],
      });
      await resource.save();
    }
    resources.push(resource);
  }

  // Demo incidents (historical timestamps for realism)
  const now = new Date();
  const mins = (m) => new Date(now - m * 60000);

  const incidentData = [
    {
      originalReport: 'Water is entering our house in MVP colony near park, send boat pls, also my uncle needs BP medicine urgently.',
      locationDescription: 'MVP Colony Sector 4, near community park',
      reportedCategory: 'Medical Emergency',
      category: 'Medical Emergency',
      affectedCountRange: '4-8',
      aiRecommendedUrgency: 'Critical',
      effectiveUrgency: 'Critical',
      triageStatus: 'completed',
      status: 'awaiting_assignment',
      verificationStatus: 'under_review',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'Critical',
        incidentTitle: 'Waterlogging & Medical Need — MVP Colony',
        summary: 'Residential flooding with trapped family and urgent medical supply (BP medicine) needed. Elderly person at risk.',
        immediateNeeds: ['Rescue boat', 'BP medicines', 'Evacuation assistance'],
        hazards: ['Rising water level', 'Submerged electric infrastructure'],
        confidence: 'medium',
        reasoning: 'Combination of flooding, trapped persons, and urgent medical need triggers Critical classification.',
        detectedLanguage: 'en',
        processedAt: mins(10),
        processingMs: 420,
      },
      isDemo: true,
    },
    {
      originalReport: 'Severe power cut for 14 hours. Diabetic patient needs cold-chain insulin pens immediately before 2 PM.',
      locationDescription: 'Seethammadhara North, near HB Colony junction',
      reportedCategory: 'Medical Emergency',
      category: 'Medical Emergency',
      affectedCountRange: '1-3',
      aiRecommendedUrgency: 'Critical',
      effectiveUrgency: 'Critical',
      triageStatus: 'completed',
      status: 'assigned',
      verificationStatus: 'verified',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'Critical',
        incidentTitle: 'Insulin Cold-Chain Emergency',
        summary: 'Diabetic patient requires refrigerated insulin within hours. 14-hour power outage compromises cold storage.',
        immediateNeeds: ['Insulin pens (cold-chain)', 'Portable power or ice pack'],
        hazards: ['Time-critical medical window'],
        confidence: 'high',
        reasoning: 'Cold-chain medication with explicit time deadline and active power outage — Critical priority.',
        detectedLanguage: 'en',
        processedAt: mins(20),
        processingMs: 380,
      },
      isDemo: true,
    },
    {
      originalReport: 'Samudram nunchi alalu vastunnayi, water intloki vachindi. 6 members terrace paina unnamu, boat pampandi pls urgent!',
      locationDescription: 'RK Beach Road fishing hamlet, near lighthouse colony',
      reportedCategory: 'Flooding',
      category: 'Flooding',
      affectedCountRange: '4-8',
      aiRecommendedUrgency: 'Critical',
      effectiveUrgency: 'Critical',
      detectedLanguage: 'mixed',
      triageStatus: 'completed',
      status: 'in_progress',
      verificationStatus: 'verified',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'Critical',
        incidentTitle: 'Terrace Evacuation Needed — RK Beach',
        summary: 'Telugu/Tanglish report: Sea flooding entered home, 6 persons trapped on terrace. Requesting boat immediately.',
        immediateNeeds: ['Rescue boat', 'Evacuation support'],
        hazards: ['Storm surge', 'Rapidly rising water'],
        confidence: 'medium',
        reasoning: 'Key terms: terrace stranded, water entered, urgent boat request — Critical classification.',
        detectedLanguage: 'mixed',
        processedAt: mins(45),
        processingMs: 510,
      },
      isDemo: true,
    },
    {
      originalReport: 'Makeshift relief school hall has 60 residents including 12 infants. Drinking water tank contaminated with flood runoff.',
      locationDescription: 'Madhurawada Phase 2, Community School Hall',
      reportedCategory: 'Food & Drinking Water',
      category: 'Food & Drinking Water',
      affectedCountRange: '25+',
      aiRecommendedUrgency: 'High',
      effectiveUrgency: 'High',
      triageStatus: 'completed',
      status: 'awaiting_assignment',
      verificationStatus: 'unverified',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'High',
        incidentTitle: 'Contaminated Water — Shelter Camp',
        summary: 'Shelter camp with 60 displaced persons including 12 infants. Water source compromised by flood runoff.',
        immediateNeeds: ['Safe drinking water (20L cans)', 'ORS sachets', 'Water purification tablets'],
        hazards: ['Waterborne disease risk', 'Infant dehydration risk'],
        confidence: 'high',
        reasoning: 'Large group including infants with contaminated water — High urgency. Scale of affect warrants priority.',
        detectedLanguage: 'en',
        processedAt: mins(65),
        processingMs: 340,
      },
      isDemo: true,
    },
    {
      originalReport: 'High storm surge washed debris onto the main road near YMCA. 2 electric cables snapped and lying on wet asphalt.',
      locationDescription: 'Beach Road near YMCA, Visakhapatnam',
      reportedCategory: 'Roadblock & Fallen Trees',
      category: 'Roadblock & Fallen Trees',
      affectedCountRange: '25+',
      aiRecommendedUrgency: 'High',
      effectiveUrgency: 'High',
      triageStatus: 'completed',
      status: 'submitted',
      verificationStatus: 'unverified',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'High',
        incidentTitle: 'Live Cables on Flooded Road',
        summary: 'Storm debris and 2 downed live electrical cables on Beach Road YMCA. Blocks emergency vehicle access corridor.',
        immediateNeeds: ['APEPDCL power isolation', 'Road clearance crew'],
        hazards: ['Live electrical cables on wet road', 'Blocks relief route'],
        confidence: 'high',
        reasoning: 'Live electrical hazard blocks key arterial road — High urgency. Electrocution risk to rescue teams.',
        detectedLanguage: 'en',
        processedAt: mins(90),
        processingMs: 290,
      },
      isDemo: true,
    },
    {
      originalReport: 'Labor pain started. Ambulance cannot enter due to knee-deep water in lane 2. Need high-clearance 4x4 vehicle.',
      locationDescription: 'Pithapuram Colony, Lane 2',
      reportedCategory: 'Medical Emergency',
      category: 'Medical Emergency',
      affectedCountRange: '1-3',
      aiRecommendedUrgency: 'Critical',
      effectiveUrgency: 'Critical',
      triageStatus: 'completed',
      status: 'resolved',
      verificationStatus: 'verified',
      aiTriage: {
        source: 'fallback', model: 'rule-based-v1',
        recommendedUrgency: 'Critical',
        incidentTitle: 'Maternity Emergency — Ambulance Blocked',
        summary: 'Pregnant woman in active labor. Ambulance cannot access due to flooding. Requires off-road 4x4 transport to KGH.',
        immediateNeeds: ['High-clearance 4x4 vehicle', 'Medical escort to KGH Hospital'],
        hazards: ['Flooded access road', 'Time-critical obstetric emergency'],
        confidence: 'high',
        reasoning: 'Active labor with blocked ambulance access — immediate Critical response required.',
        detectedLanguage: 'en',
        processedAt: mins(130),
        processingMs: 310,
      },
      isDemo: true,
    },
  ];

  const now2 = new Date();
  const incidents = [];
  for (let i = 0; i < incidentData.length; i++) {
    const d = incidentData[i];
    // Stagger creation timestamps
    const createdAt = new Date(now2 - (i + 1) * 15 * 60000);
    let inc = await Incident.findOne({ isDemo: true, originalReport: d.originalReport });
    if (!inc) {
      inc = new Incident({ ...d, createdAt, updatedAt: createdAt });
      inc.statusHistory = [{ status: d.status || 'submitted', changedByName: 'System Seed', timestamp: createdAt }];
      await inc.save();
    }
    incidents.push(inc);
  }

  const demoAssignments = [
    { incidentIndex: 1, volunteerUsername: 'priya_redcross', status: 'sent' },
    { incidentIndex: 2, volunteerUsername: 'team_delta', status: 'in_progress' },
  ];
  for (const item of demoAssignments) {
    const incident = incidents[item.incidentIndex];
    let assignment = await Assignment.findOne({
      incident: incident._id,
      isDemo: true,
      status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
    });
    if (assignment) continue;

    const volunteer = volunteers.find(user => user.username === item.volunteerUsername);
    if (!volunteer) throw new Error(`Demo volunteer ${item.volunteerUsername} is missing.`);
    assignment = await Assignment.create({
      incident: incident._id,
      incidentRef: incident.ref,
      volunteer: volunteer._id,
      volunteerName: volunteer.displayName,
      status: item.status,
      coordinatorNote: 'Seeded demo assignment',
      assignedBy: seeder._id,
      assignedByName: seeder.displayName,
      isDemo: true,
      ...(item.status === 'in_progress' ? { startedAt: incident.createdAt } : {}),
    });
    incident.assignments.addToSet(assignment._id);
    await incident.save();
    volunteer.profile.availability = 'assigned';
    await volunteer.save();
  }

  return { incidents, volunteers };
}

module.exports = router;
module.exports.seedDemoData = seedDemoData;
