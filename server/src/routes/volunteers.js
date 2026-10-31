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

const createVolunteerSchema = Joi.object({
  displayName: Joi.string().trim().min(2).max(100).required(),
  username: Joi.string().trim().min(3).max(50).pattern(/^[a-zA-Z0-9_.-]+$/).required(),
  password: Joi.string().min(8).max(128).required(),
  profile: Joi.object({
    skills: Joi.array().items(Joi.string().trim().max(80)).max(20).default([]),
    serviceArea: Joi.string().trim().max(200).allow('', null),
    teamAffiliation: Joi.string().trim().max(100).allow('', null),
  }).default({}),
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
  const canManage = ['admin', 'coordinator'].includes(req.user.role);
  const includeInactive = canManage && req.query.includeInactive === 'true';
  const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
  const filter = { role: 'volunteer', ...(!includeInactive && { isActive: true }) };
  if (availability) filter['profile.availability'] = availability;
  if (skill) filter['profile.skills'] = { $in: [skill] };

  const skip = (pageNum - 1) * pageLimit;

  const [volunteers, total] = await Promise.all([
    User.find(filter).skip(skip).limit(pageLimit).lean(),
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

  res.json({ success: true, data: safe, meta: { total, page: pageNum, limit: pageLimit } });
}));

// ============================================================================
// POST /api/volunteers — create a volunteer account (coordinator+)
// ============================================================================
router.post('/', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = createVolunteerSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const username = value.username.toLowerCase();
  if (await User.exists({ username })) throw createError('Username already taken.', 409);

  const user = await User.create({
    displayName: value.displayName,
    username,
    passwordHash: value.password,
    role: 'volunteer',
    isActive: true,
    isDemo: process.env.DEMO_MODE === 'true',
    profile: {
      ...value.profile,
      availability: 'available',
    },
  });

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'volunteer:created', entityType: 'User', entityId: user._id,
    entityRef: user.username, isDemo: user.isDemo, ipAddress: req.ip,
  });
  broadcast('volunteer:created', { volunteerId: String(user._id), displayName: user.displayName });

  res.status(201).json({ success: true, data: user.toSafeObject() });
}));

// ============================================================================
// DELETE /api/volunteers/:id — deactivate a volunteer and preserve history
// ============================================================================
router.delete('/:id', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: 'volunteer' });
  if (!user) throw createError('Volunteer not found.', 404);

  const activeAssignment = await Assignment.exists({
    volunteer: user._id,
    status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
  });
  if (activeAssignment) {
    throw createError('Volunteer has active assignments. Complete or cancel them before deactivation.', 409);
  }

  if (user.isActive) {
    const deactivated = await User.findOneAndUpdate(
      {
        _id: user._id,
        role: 'volunteer',
        isActive: true,
        'profile.availability': { $ne: 'assigned' },
      },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!deactivated) {
      throw createError('Volunteer status changed or an assignment is active. Refresh and try again.', 409);
    }
    await audit.record({
      actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
      action: 'volunteer:deactivated', entityType: 'User', entityId: deactivated._id,
      entityRef: deactivated.username, isDemo: deactivated.isDemo, ipAddress: req.ip,
    });
    broadcast('volunteer:deactivated', { volunteerId: String(deactivated._id), displayName: deactivated.displayName });
    user.isActive = deactivated.isActive;
  }

  res.json({ success: true, message: 'Volunteer deactivated; assignment history was preserved.', data: user.toSafeObject() });
}));

// ============================================================================
// PATCH /api/volunteers/:id/reactivate — restore a deactivated volunteer
// ============================================================================
router.patch('/:id/reactivate', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: 'volunteer' });
  if (!user) throw createError('Volunteer not found.', 404);

  if (!user.isActive) {
    user.isActive = true;
    const activeAssignment = await Assignment.exists({
      volunteer: user._id,
      status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
    });
    if (user.profile?.availability === 'assigned' || activeAssignment) {
      if (!user.profile) user.profile = {};
      user.profile.availability = activeAssignment ? 'assigned' : 'available';
    }
    await user.save();
    await audit.record({
      actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
      action: 'volunteer:reactivated', entityType: 'User', entityId: user._id,
      entityRef: user.username, isDemo: user.isDemo, ipAddress: req.ip,
    });
    broadcast('volunteer:reactivated', { volunteerId: String(user._id), displayName: user.displayName });
  }

  res.json({ success: true, message: 'Volunteer reactivated.', data: user.toSafeObject() });
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
  if (req.user.role === 'volunteer') {
    if (String(req.user._id) !== targetId) {
      throw createError('You can only update your own availability.', 403);
    }
  } else if (!['admin', 'coordinator'].includes(req.user.role)) {
    throw createError('Access denied. Required role(s): admin, coordinator.', 403);
  }

  const { error, value } = updateAvailSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const user = await User.findById(targetId);
  if (!user || user.role !== 'volunteer') throw createError('Volunteer not found.', 404);

  if (value.availability === 'available' && await Assignment.exists({
    volunteer: user._id,
    status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
  })) {
    throw createError('Volunteer has active assignments and cannot be marked available yet.', 409);
  }

  const availabilityFilter = { _id: user._id, role: 'volunteer', isActive: true };
  if (value.availability === 'available') {
    availabilityFilter['profile.availability'] = { $ne: 'assigned' };
  }
  const updatedUser = await User.findOneAndUpdate(
    availabilityFilter,
    { $set: { 'profile.availability': value.availability } },
    { new: true }
  );
  if (!updatedUser) {
    throw createError('Volunteer status changed or an assignment is active. Refresh and try again.', 409);
  }

  res.json({ success: true, message: 'Availability updated.', user: updatedUser.toSafeObject() });
}));

// ============================================================================
// POST /api/volunteers/assign — assign volunteer to incident (coordinator+)
// ============================================================================
router.post('/assign', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = assignSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const { incidentId } = req.query;
  if (!incidentId) throw createError('incidentId query param is required.', 422);

  const incident = await Incident.findById(incidentId);
  if (!incident) throw createError('Incident not found.', 404);

  const existingVolunteer = await User.findById(value.volunteerId);
  if (!existingVolunteer || existingVolunteer.role !== 'volunteer' || !existingVolunteer.isActive) {
    throw createError('Volunteer not found or inactive.', 404);
  }
  const activeAssignment = await Assignment.exists({
    volunteer: existingVolunteer._id,
    status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
  });
  if (existingVolunteer.profile?.availability !== 'available' || activeAssignment) {
    const availability = activeAssignment ? 'assigned' : existingVolunteer.profile?.availability || 'unavailable';
    throw createError(`Volunteer "${existingVolunteer.displayName}" is currently ${availability}. Cannot assign.`, 409);
  }

  const volunteer = await User.findOneAndUpdate(
    {
      _id: existingVolunteer._id,
      role: 'volunteer',
      isActive: true,
      'profile.availability': 'available',
    },
    { $set: { 'profile.availability': 'assigned' } },
    { new: true }
  );
  if (!volunteer) {
    throw createError('This volunteer was assigned by another coordinator. Refresh the volunteer list and try again.', 409);
  }

  let assignment;
  try {
    assignment = await Assignment.create({
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
  } catch (err) {
    await Promise.all([
      assignment ? Assignment.deleteOne({ _id: assignment._id }) : Promise.resolve(),
      User.updateOne(
        { _id: volunteer._id, 'profile.availability': 'assigned' },
        { $set: { 'profile.availability': 'available' } }
      ),
    ]);
    throw err;
  }

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

  // Volunteers can only update their own assignment; coordinators/admins may update any.
  if (req.user.role === 'volunteer') {
    if (String(assignment.volunteer) !== String(req.user._id)) {
      throw createError('You can only update your own assignments.', 403);
    }
  } else if (!['admin', 'coordinator'].includes(req.user.role)) {
    throw createError('Access denied. Required role(s): volunteer, coordinator, admin.', 403);
  }

  assignment.status = value.status;
  if (value.volunteerNote) assignment.volunteerNote = value.volunteerNote;

  if (value.status === 'acknowledged') assignment.acknowledgedAt = new Date();
  if (value.status === 'in_progress')  assignment.startedAt     = new Date();
  if (value.status === 'completed')    assignment.completedAt   = new Date();

  await assignment.save();

  if (['completed', 'cancelled'].includes(value.status)) {
    const activeAssignment = await Assignment.exists({
      volunteer: assignment.volunteer,
      status: { $in: ['pending', 'sent', 'acknowledged', 'in_progress'] },
    });
    if (!activeAssignment) {
      await User.updateOne(
        { _id: assignment.volunteer, role: 'volunteer', isActive: true },
        { $set: { 'profile.availability': 'available' } }
      );
    }
  }

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
