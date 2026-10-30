'use strict';

const express = require('express');
const Joi = require('joi');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const Incident = require('../models/Incident');
const audit = require('../services/auditService');
const { broadcast } = require('../utils/sse');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, createError } = require('../middleware/errorHandler');

const router = express.Router();

// ---- Schemas ----
const assignSchema = Joi.object({
  volunteerId:     Joi.string().required(),
  coordinatorNote: Joi.string().max(1000).allow('', null),
});

const updateAvailSchema = Joi.object({
  availability: Joi.string().valid('available', 'assigned', 'unavailable', 'off-duty').required(),
});

const progressSchema = Joi.object({
  status: Joi.string().valid('acknowledged', 'in_progress', 'completed', 'cancelled').required(),
  volunteerNote: Joi.string().max(1000).allow('', null),
});

// ============================================================================
// GET /api/volunteers — list available volunteers
// ============================================================================
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { availability, skill, page = 1, limit = 50 } = req.query;
  const filter = { role: 'volunteer', isActive: true };
  if (availability) filter['profile.availability'] = availability;
  if (skill) filter['profile.skills'] = { $in: [skill] };

  const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));

  const [volunteers, total] = await Promise.all([
    User.find(filter).skip(skip).limit(parseInt(limit)).lean(),
    User.countDocuments(filter),
  ]);

  // For non-admins/coordinators, strip phone
  const safe = volunteers.map(v => {
    const obj = { ...v };
    delete obj.passwordHash;
    if (!['admin', 'coordinator'].includes(req.user.role)) {
      delete obj.profile?.phone;
    }
    return obj;
  });

  res.json({ success: true, data: safe, meta: { total, page: parseInt(page) } });
}));

// ============================================================================
// GET /api/volunteers/me — volunteer's own profile + assignments
// ============================================================================
router.get('/me', authenticate, authorize('volunteer', 'coordinator', 'admin'), asyncHandler(async (req, res) => {
  const assignments = await Assignment.find({ volunteer: req.user._id })
    .populate('incident', 'ref locationDescription effectiveUrgency status')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  res.json({ success: true, user: req.user.toSafeObject(), assignments });
}));

// ============================================================================
// PATCH /api/volunteers/:id/availability — update own availability
// ============================================================================
router.patch('/:id/availability', authenticate, asyncHandler(async (req, res) => {
  // Volunteers can only update their own; coordinators/admins can update any
  const targetId = req.params.id;
  if (req.user.role === 'volunteer' && String(req.user._id) !== targetId) {
    throw createError('You can only update your own availability.', 403);
  }

  const { error, value } = updateAvailSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const user = await User.findById(targetId);
  if (!user || user.role !== 'volunteer') throw createError('Volunteer not found.', 404);

  if (!user.profile) user.profile = {};
  user.profile.availability = value.availability;
  user.markModified('profile');
  await user.save();

  res.json({ success: true, message: 'Availability updated.', user: user.toSafeObject() });
}));

// ============================================================================
// POST /api/volunteers/assign — assign volunteer to incident (coordinator+)
// ============================================================================
router.post('/assign', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = assignSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const { incidentId } = req.query;
  if (!incidentId) throw createError('incidentId query param is required.', 422);

  const [volunteer, incident] = await Promise.all([
    User.findById(value.volunteerId),
    Incident.findById(incidentId),
  ]);

  if (!volunteer || volunteer.role !== 'volunteer' || !volunteer.isActive) {
    throw createError('Volunteer not found or inactive.', 404);
  }
  if (!incident) throw createError('Incident not found.', 404);

  // Enforce availability
  if (volunteer.profile?.availability === 'unavailable' || volunteer.profile?.availability === 'off-duty') {
    throw createError(`Volunteer "${volunteer.displayName}" is currently ${volunteer.profile.availability}. Cannot assign.`, 409);
  }

  // Create assignment
  const assignment = await Assignment.create({
    incident:        incident._id,
    incidentRef:     incident.ref,
    volunteer:       volunteer._id,
    volunteerName:   volunteer.displayName,
    status:          'sent',
    coordinatorNote: value.coordinatorNote || null,
    assignedBy:      req.user._id,
    assignedByName:  req.user.displayName,
    isDemo:          incident.isDemo,
  });

  // Update volunteer availability
  if (!volunteer.profile) volunteer.profile = {};
  volunteer.profile.availability = 'assigned';
  volunteer.markModified('profile');
  await volunteer.save();

  // Add assignment reference to incident & advance status
  incident.assignments.push(assignment._id);
  if (['submitted', 'under_review', 'verified', 'awaiting_assignment'].includes(incident.status)) {
    incident.status = 'assigned';
    incident.statusHistory.push({
      status: 'assigned',
      changedBy: req.user._id,
      changedByName: req.user.displayName,
      note: `Assigned to ${volunteer.displayName}`,
      timestamp: new Date(),
    });
  }
  await incident.save();

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'assignment:created', entityType: 'Assignment',
    entityId: assignment._id, entityRef: assignment.ref,
    changes: { volunteer: volunteer.displayName, incident: incident.ref },
    isDemo: incident.isDemo, ipAddress: req.ip,
  });

  broadcast('assignment:created', {
    assignmentRef: assignment.ref, incidentRef: incident.ref,
    volunteerName: volunteer.displayName, status: 'sent',
  });

  res.status(201).json({ success: true, data: assignment });
}));

// ============================================================================
// PATCH /api/volunteers/assignments/:assignmentId — volunteer updates progress
// ============================================================================
router.patch('/assignments/:assignmentId', authenticate, asyncHandler(async (req, res) => {
  const { error, value } = progressSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const assignment = await Assignment.findById(req.params.assignmentId)
    .populate('incident');
  if (!assignment) throw createError('Assignment not found.', 404);

  // Volunteers can only update their own assignment
  if (req.user.role === 'volunteer' && String(assignment.volunteer) !== String(req.user._id)) {
    throw createError('You can only update your own assignments.', 403);
  }

  assignment.status = value.status;
  if (value.volunteerNote) assignment.volunteerNote = value.volunteerNote;

  if (value.status === 'acknowledged') assignment.acknowledgedAt = new Date();
  if (value.status === 'in_progress')  assignment.startedAt     = new Date();
  if (value.status === 'completed')    assignment.completedAt   = new Date();

  await assignment.save();

  // Cascade incident status
  const inc = assignment.incident;
  if (inc) {
    const map = { acknowledged: 'acknowledged', in_progress: 'in_progress', completed: 'assistance_delivered' };
    const newStatus = map[value.status];
    if (newStatus) {
      const allowed = (Incident.INCIDENT_STATUSES || []);
      const currentIdx = allowed.indexOf(inc.status);
      const newIdx = allowed.indexOf(newStatus);
      if (newIdx > currentIdx) {
        inc.status = newStatus;
        inc.statusHistory.push({
          status: newStatus, changedByName: req.user.displayName,
          note: `Volunteer update: ${value.status}`, timestamp: new Date(),
        });
        await inc.save();
      }
    }
  }

  broadcast('assignment:updated', {
    assignmentRef: assignment.ref, incidentRef: assignment.incidentRef,
    status: value.status, volunteerName: assignment.volunteerName,
  });

  res.json({ success: true, data: assignment });
}));

module.exports = router;

