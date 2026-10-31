'use strict';

const express = require('express');
const Incident = require('../models/Incident');
const Assignment = require('../models/Assignment');
const Resource = require('../models/Resource');
const User = require('../models/User');
const AuditEvent = require('../models/AuditEvent');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
const CLOSED_STATUSES = ['assistance_delivered', 'resolved', 'closed', 'cancelled'];
const availableStockExpression = {
  $subtract: ['$quantityTotal', { $add: ['$quantityReserved', '$quantityDispatched'] }],
};

// Only coordinators, analysts, admins can see analytics
router.use(authenticate, authorize('admin', 'coordinator', 'analyst'));

// ============================================================================
// GET /api/analytics/summary — dashboard KPIs
// ============================================================================
router.get('/summary', asyncHandler(async (req, res) => {
  const { isDemo } = req.query;
  const demoFilter = isDemo !== undefined ? { isDemo: isDemo === 'true' } : {};

  const [
    totalIncidents,
    openIncidents,
    criticalIncidents,
    highIncidents,
    awaitingAssignment,
    inProgress,
    resolved,
    confirmedDuplicates,
    totalVolunteers,
    availableVolunteers,
    assignedVolunteers,
    totalResources,
    resourceStats,
  ] = await Promise.all([
    Incident.countDocuments(demoFilter),
    Incident.countDocuments({ ...demoFilter, status: { $nin: CLOSED_STATUSES } }),
    Incident.countDocuments({ ...demoFilter, effectiveUrgency: 'Critical', status: { $nin: CLOSED_STATUSES } }),
    Incident.countDocuments({ ...demoFilter, effectiveUrgency: 'High', status: { $nin: CLOSED_STATUSES } }),
    Incident.countDocuments({ ...demoFilter, status: { $in: ['awaiting_assignment', 'verified', 'submitted', 'under_review'] } }),
    Incident.countDocuments({ ...demoFilter, status: { $in: ['in_progress', 'acknowledged', 'assigned'] } }),
    Incident.countDocuments({ ...demoFilter, status: { $in: ['assistance_delivered', 'resolved', 'closed'] } }),
    Incident.countDocuments({ ...demoFilter, duplicateTag: 'confirmed_duplicate' }),
    User.countDocuments({ role: 'volunteer', isActive: true }),
    User.countDocuments({ role: 'volunteer', isActive: true, 'profile.availability': 'available' }),
    User.countDocuments({ role: 'volunteer', isActive: true, 'profile.availability': 'assigned' }),
    Resource.countDocuments(demoFilter),
    Resource.aggregate([
      { $match: demoFilter },
      { $group: {
        _id: null,
        totalDispatched: { $sum: '$quantityDispatched' },
        totalReserved: { $sum: '$quantityReserved' },
        totalAvailable: { $sum: { $cond: [{ $gt: [availableStockExpression, 0] }, availableStockExpression, 0] } },
      }},
    ]),
  ]);

  const resStats = resourceStats[0] || { totalDispatched: 0, totalReserved: 0, totalAvailable: 0 };

  res.json({
    success: true,
    data: {
      incidents: {
        total: totalIncidents, open: openIncidents, critical: criticalIncidents, high: highIncidents,
        awaitingAssignment, inProgress, resolved,
        confirmedDuplicates,
        duplicateRate: totalIncidents ? (confirmedDuplicates / totalIncidents) * 100 : 0,
      },
      volunteers: { total: totalVolunteers, available: availableVolunteers, assigned: assignedVolunteers },
      resources: { total: totalResources, dispatched: resStats.totalDispatched, reserved: resStats.totalReserved, available: resStats.totalAvailable },
    },
  });
}));

// ============================================================================
// GET /api/analytics/incidents-by-category
// ============================================================================
router.get('/incidents-by-category', asyncHandler(async (req, res) => {
  const { isDemo } = req.query;
  const match = isDemo !== undefined ? { isDemo: isDemo === 'true' } : {};

  const data = await Incident.aggregate([
    { $match: match },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  res.json({ success: true, data });
}));

// ============================================================================
// GET /api/analytics/incidents-by-urgency
// ============================================================================
router.get('/incidents-by-urgency', asyncHandler(async (req, res) => {
  const { isDemo } = req.query;
  const match = isDemo !== undefined ? { isDemo: isDemo === 'true' } : {};

  const data = await Incident.aggregate([
    { $match: match },
    { $group: { _id: '$effectiveUrgency', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  res.json({ success: true, data });
}));

// ============================================================================
// GET /api/analytics/incidents-trend — daily counts over time
// ============================================================================
router.get('/incidents-trend', asyncHandler(async (req, res) => {
  const { days = 7, isDemo } = req.query;
  const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
  const match = { createdAt: { $gte: cutoff } };
  if (isDemo !== undefined) match.isDemo = isDemo === 'true';

  const data = await Incident.aggregate([
    { $match: match },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
      count: { $sum: 1 },
    }},
    { $sort: { _id: 1 } },
  ]);

  res.json({ success: true, data });
}));

// ============================================================================
// GET /api/analytics/resource-usage
// ============================================================================
router.get('/resource-usage', asyncHandler(async (req, res) => {
  const { isDemo } = req.query;
  const match = isDemo !== undefined ? { isDemo: isDemo === 'true' } : {};

  const data = await Resource.aggregate([
    { $match: match },
    { $group: {
      _id: '$resourceType',
      totalDispatched: { $sum: '$quantityDispatched' },
      totalReserved: { $sum: '$quantityReserved' },
      totalAvailable: { $sum: { $cond: [{ $gt: [availableStockExpression, 0] }, availableStockExpression, 0] } },
    }},
    { $sort: { totalDispatched: -1 } },
  ]);

  res.json({ success: true, data });
}));

// ============================================================================
// GET /api/analytics/audit — recent audit trail (admin only)
// ============================================================================
router.get('/audit', authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, entityType, action } = req.query;
  const filter = {};
  if (entityType) filter.entityType = entityType;
  if (action) filter.action = { $regex: action, $options: 'i' };

  const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));

  const [events, total] = await Promise.all([
    AuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    AuditEvent.countDocuments(filter),
  ]);

  res.json({ success: true, data: events, meta: { total, page: parseInt(page) } });
}));

module.exports = router;
