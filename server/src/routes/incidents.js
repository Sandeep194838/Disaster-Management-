'use strict';

const express = require('express');
const Joi = require('joi');
const Incident = require('../models/Incident');
const Assignment = require('../models/Assignment');
const { runTriage } = require('../services/triageService');
const { findCandidates } = require('../services/duplicateService');
const audit = require('../services/auditService');
const { broadcast } = require('../utils/sse');
const { authenticate, authorize, optionalAuth } = require('../middleware/auth');
const { asyncHandler, createError } = require('../middleware/errorHandler');

const router = express.Router();

const { URGENCY_LEVELS, CATEGORIES, INCIDENT_STATUSES } = Incident;

// ---- Valid status transitions ------------------------------------------------
const VALID_TRANSITIONS = {
  submitted:            ['under_review', 'cancelled'],
  under_review:         ['verified', 'cancelled', 'submitted'],
  verified:             ['awaiting_assignment', 'cancelled'],
  awaiting_assignment:  ['assigned', 'cancelled'],
  assigned:             ['acknowledged', 'awaiting_assignment', 'cancelled'],
  acknowledged:         ['in_progress', 'awaiting_assignment'],
  in_progress:          ['assistance_delivered', 'awaiting_assignment'],
  assistance_delivered: ['resolved'],
  resolved:             ['closed', 'in_progress'],
  closed:               [],
  cancelled:            [],
};

// ---- Validation schemas ------------------------------------------------------
const createIncidentSchema = Joi.object({
  originalReport:       Joi.string().min(10).max(5000).required(),
  locationDescription:  Joi.string().min(3).max(500).required(),
  reportedCategory:     Joi.string().valid(...CATEGORIES).allow(null, '').default(null),
  affectedCountRange:   Joi.string().max(20).allow('', null),
  contactPhone:         Joi.string().pattern(/^\+?[0-9\s\-]{7,15}$/).allow('', null),
  contactName:          Joi.string().max(100).allow('', null),
  coordinates: Joi.object({
    lat:      Joi.number().min(-90).max(90).required(),
    lng:      Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).allow(null),
    source:   Joi.string().valid('gps', 'geocoded', 'manual', 'approximate').default('manual'),
  }).allow(null),
  isDemo: Joi.boolean().default(false),
});

const updateIncidentSchema = Joi.object({
  locationDescription: Joi.string().min(3).max(500),
  category:            Joi.string().valid(...CATEGORIES).allow(null),
  coordinatorUrgency:  Joi.string().valid(...URGENCY_LEVELS).allow(null),
  urgencyOverrideReason: Joi.string().max(500).allow('', null),
  requiredResources:   Joi.array().items(Joi.string().max(200)),
  resolutionNote:      Joi.string().max(2000).allow('', null),
  verificationStatus:  Joi.string().valid('unverified', 'under_review', 'verified', 'false_alarm'),
});

const statusChangeSchema = Joi.object({
  status: Joi.string().valid(...INCIDENT_STATUSES).required(),
  note:   Joi.string().max(1000).allow('', null),
});

// ---- Helper ------------------------------------------------------------------
function sanitizeForPublic(inc) {
  const obj = typeof inc.toObject === 'function' ? inc.toObject({ virtuals: true }) : { ...inc };
  // Strip server-side sensitive fields
  delete obj.contactPhone;
  delete obj.contactName;
  delete obj.__v;
  return obj;
}

// ============================================================================
// GET /api/incidents — list with filters, sorting, pagination
// ============================================================================
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const {
    urgency, category, status, isDemo,
    search, page = 1, limit = 30,
    sortBy = 'createdAt', sortDir = 'desc',
    from, to,
  } = req.query;

  const filter = {};

  // Demo/operational separation
  if (isDemo !== undefined) filter.isDemo = isDemo === 'true';

  // Urgency filter
  if (urgency && urgency !== 'ALL' && URGENCY_LEVELS.includes(urgency)) {
    filter.effectiveUrgency = urgency;
  }

  // Category filter
  if (category && category !== 'ALL' && CATEGORIES.includes(category)) {
    filter.category = category;
  }

  // Status filter
  if (status && status !== 'ALL' && INCIDENT_STATUSES.includes(status)) {
    filter.status = status;
  }

  // Date range
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  // Text search
  if (search && search.trim()) {
    filter.$text = { $search: search.trim() };
  }

  const pageNum = Math.max(1, parseInt(page));
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * pageLimit;
  const sortOrder = sortDir === 'asc' ? 1 : -1;

  const [incidents, total] = await Promise.all([
    Incident.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(pageLimit)
      .populate('assignments', 'status volunteerName ref')
      .lean({ virtuals: true }),
    Incident.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: incidents.map(sanitizeForPublic),
    meta: { total, page: pageNum, limit: pageLimit, pages: Math.ceil(total / pageLimit) },
  });
}));

// ============================================================================
// POST /api/incidents — create new incident
// ============================================================================
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
  const { error, value } = createIncidentSchema.validate(req.body, { abortEarly: false });
  if (error) {
    const msg = error.details.map(d => d.message).join('; ');
    throw createError(msg, 422);
  }

  const incidentData = {
    originalReport:      value.originalReport,
    locationDescription: value.locationDescription,
    reportedCategory:    value.reportedCategory || null,
    category:            value.reportedCategory || null,
    affectedCountRange:  value.affectedCountRange || null,
    isDemo:              value.isDemo || false,
    status:              'submitted',
    triageStatus:        'pending',
    isAnonymous:         !req.user,
  };

  if (req.user) {
    incidentData.reportedBy     = req.user._id;
    incidentData.reportedByName = req.user.displayName;
  }

  if (value.coordinates) {
    incidentData.coordinates = value.coordinates;
    incidentData.locationVerificationStatus = 'reported';
  }

  // Store contact info server-side only (never returned in public responses)
  if (value.contactPhone) incidentData.contactPhone = value.contactPhone;
  if (value.contactName)  incidentData.contactName  = value.contactName;

  const incident = await Incident.create(incidentData);

  // Add initial status history entry
  incident.statusHistory.push({
    status: 'submitted',
    changedByName: req.user ? req.user.displayName : 'Public Reporter',
    note: 'Incident submitted',
    timestamp: new Date(),
  });
  await incident.save();

  await audit.record({
    actor: req.user?._id, actorName: req.user?.displayName || 'Anonymous',
    actorRole: req.user?.role,
    action: 'incident:created', entityType: 'Incident',
    entityId: incident._id, entityRef: incident.ref,
    isDemo: incident.isDemo, ipAddress: req.ip,
  });

  // Broadcast SSE
  broadcast('incident:created', { incident: sanitizeForPublic(incident) });

  res.status(201).json({ success: true, data: sanitizeForPublic(incident) });
}));

// ============================================================================
// GET /api/incidents/:id — single incident detail
// ============================================================================
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  const incident = await Incident.findById(req.params.id)
    .populate('assignments')
    .populate('reportedBy', 'displayName username role')
    .populate('verifiedBy', 'displayName username')
    .populate('urgencyOverriddenBy', 'displayName username')
    .lean({ virtuals: true });

  if (!incident) throw createError('Incident not found.', 404);

  res.json({ success: true, data: sanitizeForPublic(incident) });
}));

// ============================================================================
// PATCH /api/incidents/:id — update fields (coordinator+)
// ============================================================================
router.patch('/:id', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = updateIncidentSchema.validate(req.body, { abortEarly: false });
  if (error) throw createError(error.details.map(d => d.message).join('; '), 422);

  const incident = await Incident.findById(req.params.id);
  if (!incident) throw createError('Incident not found.', 404);

  const changed = {};

  if (value.locationDescription !== undefined) {
    incident.locationDescription = value.locationDescription;
    changed.locationDescription = value.locationDescription;
  }
  if (value.category !== undefined) {
    incident.category = value.category;
    changed.category = value.category;
  }
  if (value.requiredResources !== undefined) {
    incident.requiredResources = value.requiredResources;
  }
  if (value.resolutionNote !== undefined) {
    incident.resolutionNote = value.resolutionNote;
  }
  if (value.verificationStatus !== undefined) {
    incident.verificationStatus = value.verificationStatus;
    if (value.verificationStatus === 'verified') {
      incident.verifiedBy = req.user._id;
      incident.verifiedAt = new Date();
    }
  }

  // Urgency override — NEVER auto-downgrade a previously verified Critical
  if (value.coordinatorUrgency !== undefined) {
    const previousCoord = incident.coordinatorUrgency;
    const previousEffective = incident.effectiveUrgency;

    // Prevent downgrading from Critical if verification status is 'verified'
    if (previousCoord === 'Critical' && incident.verificationStatus === 'verified' && value.coordinatorUrgency !== 'Critical') {
      throw createError('Cannot downgrade a coordinator-verified Critical incident. Change verification status first.', 409);
    }

    incident.coordinatorUrgency = value.coordinatorUrgency || null;
    incident.urgencyOverriddenBy = req.user._id;
    incident.urgencyOverriddenAt = new Date();
    incident.urgencyOverrideReason = value.urgencyOverrideReason || null;
    changed.urgency = { from: previousEffective, to: incident.coordinatorUrgency || incident.aiRecommendedUrgency };
  }

  await incident.save();

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'incident:updated', entityType: 'Incident',
    entityId: incident._id, entityRef: incident.ref,
    changes: changed, isDemo: incident.isDemo, ipAddress: req.ip,
  });

  broadcast('incident:updated', { incident: sanitizeForPublic(incident) });

  res.json({ success: true, data: sanitizeForPublic(incident) });
}));

// ============================================================================
// POST /api/incidents/:id/status — change status (coordinator+)
// ============================================================================
router.post('/:id/status', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = statusChangeSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const incident = await Incident.findById(req.params.id);
  if (!incident) throw createError('Incident not found.', 404);

  const allowed = VALID_TRANSITIONS[incident.status] || [];
  if (!allowed.includes(value.status)) {
    throw createError(
      `Invalid status transition: ${incident.status} → ${value.status}. Allowed: ${allowed.join(', ') || 'none'}.`,
      409
    );
  }

  incident.statusHistory.push({
    status: value.status,
    changedBy: req.user._id,
    changedByName: req.user.displayName,
    note: value.note || null,
    timestamp: new Date(),
  });
  incident.status = value.status;

  if (value.status === 'closed' || value.status === 'resolved') {
    incident.closedAt = new Date();
  }

  await incident.save();

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'incident:status_changed', entityType: 'Incident',
    entityId: incident._id, entityRef: incident.ref,
    changes: { from: incident.statusHistory[incident.statusHistory.length - 2]?.status, to: value.status },
    isDemo: incident.isDemo, ipAddress: req.ip,
  });

  broadcast('incident:status_changed', {
    incidentId: incident._id, incidentRef: incident.ref,
    status: value.status, changedBy: req.user.displayName,
  });

  res.json({ success: true, data: sanitizeForPublic(incident) });
}));

// ============================================================================
// POST /api/incidents/:id/triage — run AI triage
// ============================================================================
router.post('/:id/triage', optionalAuth, asyncHandler(async (req, res) => {
  const incident = await Incident.findById(req.params.id);
  if (!incident) throw createError('Incident not found.', 404);

  if (incident.triageStatus === 'processing') {
    throw createError('Triage is already in progress for this incident.', 409);
  }

  incident.triageStatus = 'processing';
  await incident.save();

  let triageResult;
  try {
    triageResult = await runTriage({
      reportText:        incident.originalReport,
      location:          incident.locationDescription,
      userCategory:      incident.reportedCategory,
      affectedCountRange: incident.affectedCountRange,
    });
  } catch (err) {
    incident.triageStatus = 'failed';
    await incident.save();
    throw createError(`Triage failed: ${err.message}`, 500);
  }

  // Apply triage results
  incident.aiTriage = {
    source:                 triageResult.source,
    model:                  triageResult.model,
    recommendedUrgency:     triageResult.recommendedUrgency,
    recommendedCategory:    triageResult.recommendedCategory,
    incidentTitle:          triageResult.incidentTitle,
    summary:                triageResult.summary,
    affectedCount:          triageResult.affectedCount,
    immediateNeeds:         triageResult.immediateNeeds,
    hazards:                triageResult.hazards,
    recommendedNextSteps:   triageResult.recommendedNextSteps,
    missingInfo:            triageResult.missingInfo,
    confidence:             triageResult.confidence,
    reasoning:              triageResult.reasoning,
    detectedLanguage:       triageResult.detectedLanguage,
    rawResponse:            triageResult.rawResponse,
    processedAt:            triageResult.processedAt,
    processingMs:           triageResult.processingMs,
  };

  incident.aiRecommendedUrgency = triageResult.recommendedUrgency;
  incident.detectedLanguage      = triageResult.detectedLanguage;
  if (triageResult.recommendedCategory && !incident.category) {
    incident.category = triageResult.recommendedCategory;
  }
  incident.triageStatus = 'completed';

  // Upgrade status from submitted → under_review
  if (incident.status === 'submitted') {
    incident.status = 'under_review';
    incident.statusHistory.push({
      status: 'under_review',
      changedByName: 'AI Triage Engine',
      note: `Triage completed by ${triageResult.source}. Urgency: ${triageResult.recommendedUrgency}.`,
      timestamp: new Date(),
    });
  }

  await incident.save();

  // Duplicate check
  const candidates = await findCandidates({
    locationDescription: incident.locationDescription,
    reportText:          incident.originalReport,
    category:            incident.category,
    coordinates:         incident.coordinates,
    excludeId:           incident._id,
    isDemo:              incident.isDemo,
  });

  incident.duplicateCheck = {
    performedAt: new Date(),
    candidateMatches: candidates.map(c => ({
      incidentId:      c.incidentId,
      incidentRef:     c.incidentRef,
      similarityScore: c.similarityScore,
      matchReasons:    c.matchReasons,
      duplicateTag:    c.duplicateTag,
    })),
  };
  await incident.save();

  broadcast('incident:triage_complete', {
    incidentId: incident._id, incidentRef: incident.ref,
    urgency: triageResult.recommendedUrgency, source: triageResult.source,
    duplicateCandidates: candidates.length,
  });

  res.json({
    success: true,
    data: sanitizeForPublic(incident),
    triage: {
      source:             triageResult.source,
      processingMs:       triageResult.processingMs,
      recommendedUrgency: triageResult.recommendedUrgency,
      confidence:         triageResult.confidence,
    },
    duplicates: {
      candidateCount: candidates.length,
      message: candidates.length > 0
        ? `${candidates.length} possible related report(s) found — coordinator review recommended.`
        : 'No likely matches found in the current dataset.',
      candidates,
    },
  });
}));

// ============================================================================
// GET /api/incidents/:id/duplicates — get duplicate candidates
// ============================================================================
router.get('/:id/duplicates', authenticate, asyncHandler(async (req, res) => {
  const incident = await Incident.findById(req.params.id).lean();
  if (!incident) throw createError('Incident not found.', 404);

  const candidates = await findCandidates({
    locationDescription: incident.locationDescription,
    reportText:          incident.originalReport,
    category:            incident.category,
    coordinates:         incident.coordinates,
    excludeId:           incident._id,
    isDemo:              incident.isDemo,
  });

  res.json({
    success: true,
    incidentRef: incident.ref,
    message: candidates.length > 0
      ? `${candidates.length} possible related report(s) found.`
      : 'No likely matches found in the current dataset.',
    candidates,
  });
}));

// ============================================================================
// POST /api/incidents/:id/link — link related incidents (coordinator+)
// ============================================================================
router.post('/:id/link', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { relatedId, duplicateTag = 'related' } = req.body;
  if (!relatedId) throw createError('relatedId is required.', 422);
  if (!Incident.DUPLICATE_TAGS.includes(duplicateTag)) {
    throw createError(`duplicateTag must be one of: ${Incident.DUPLICATE_TAGS.join(', ')}.`, 422);
  }

  const [incident, related] = await Promise.all([
    Incident.findById(req.params.id),
    Incident.findById(relatedId),
  ]);

  if (!incident) throw createError('Incident not found.', 404);
  if (!related)  throw createError('Related incident not found.', 404);

  if (!incident.relatedIncidents.includes(related._id)) {
    incident.relatedIncidents.push(related._id);
  }
  incident.duplicateTag = duplicateTag;
  await incident.save();

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'incident:linked', entityType: 'Incident',
    entityId: incident._id, entityRef: incident.ref,
    changes: { linkedTo: related.ref, tag: duplicateTag },
    isDemo: incident.isDemo, ipAddress: req.ip,
  });

  res.json({ success: true, message: `Incidents linked as "${duplicateTag}".`, data: sanitizeForPublic(incident) });
}));

module.exports = router;

