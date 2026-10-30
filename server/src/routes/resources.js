'use strict';

const express = require('express');
const Joi = require('joi');
const mongoose = require('mongoose');
const Resource = require('../models/Resource');
const audit = require('../services/auditService');
const { authenticate, authorize } = require('../middleware/auth');
const { asyncHandler, createError } = require('../middleware/errorHandler');

const router = express.Router();
const { RESOURCE_TYPES } = Resource;

// ---- Schemas ----
const createResourceSchema = Joi.object({
  name:              Joi.string().min(2).max(200).required(),
  resourceType:      Joi.string().valid(...RESOURCE_TYPES).required(),
  unit:              Joi.string().min(1).max(50).required(),
  quantityTotal:     Joi.number().min(0).required(),
  storageLocation:   Joi.string().max(300).allow('', null),
  responsibleOrg:    Joi.string().max(200).allow('', null),
  lowStockThreshold: Joi.number().min(0).default(10),
  isDemo:            Joi.boolean().default(false),
});

const movementSchema = Joi.object({
  action:      Joi.string().valid('reserve', 'dispatch', 'add_stock', 'return', 'mark_damaged').required(),
  quantity:    Joi.number().min(1).required(),
  note:        Joi.string().max(500).allow('', null),
  incidentRef: Joi.string().max(50).allow('', null),
});

// ============================================================================
// GET /api/resources
// ============================================================================
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { type, status, isDemo, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (type && RESOURCE_TYPES.includes(type)) filter.resourceType = type;
  if (status) filter.status = status;
  if (isDemo !== undefined) filter.isDemo = isDemo === 'true';

  const skip = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));

  const [resources, total] = await Promise.all([
    Resource.find(filter).skip(skip).limit(parseInt(limit)).lean({ virtuals: true }),
    Resource.countDocuments(filter),
  ]);

  res.json({ success: true, data: resources, meta: { total, page: parseInt(page) } });
}));

// ============================================================================
// POST /api/resources — create resource (coordinator+)
// ============================================================================
router.post('/', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = createResourceSchema.validate(req.body, { abortEarly: false });
  if (error) throw createError(error.details.map(d => d.message).join('; '), 422);

  const resource = await Resource.create({
    ...value,
    movementHistory: [{
      action: 'stock_added',
      quantity: value.quantityTotal,
      byUser: req.user._id,
      byUserName: req.user.displayName,
      note: 'Initial stock entry',
    }],
  });

  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'resource:created', entityType: 'Resource',
    entityId: resource._id, entityRef: resource.ref,
    changes: { name: resource.name, quantity: resource.quantityTotal },
    isDemo: resource.isDemo, ipAddress: req.ip,
  });

  const result = resource.toObject({ virtuals: true });
  res.status(201).json({ success: true, data: result });
}));

// ============================================================================
// POST /api/resources/:id/movement — stock action (coordinator+)
// Uses a MongoDB transaction-like atomic update to prevent race conditions.
// ============================================================================
router.post('/:id/movement', authenticate, authorize('admin', 'coordinator'), asyncHandler(async (req, res) => {
  const { error, value } = movementSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const resource = await Resource.findById(req.params.id).session(session);
    if (!resource) throw createError('Resource not found.', 404);

    const avail = resource.quantityTotal - resource.quantityReserved - resource.quantityDispatched;

    switch (value.action) {
      case 'reserve':
        if (value.quantity > avail) throw createError(`Only ${avail} ${resource.unit} available. Cannot reserve ${value.quantity}.`, 409);
        resource.quantityReserved += value.quantity;
        break;

      case 'dispatch':
        if (value.quantity > resource.quantityReserved) {
          // Allow dispatch from available stock if not pre-reserved
          if (value.quantity > avail) throw createError(`Insufficient stock. Available: ${avail} ${resource.unit}.`, 409);
          resource.quantityDispatched += value.quantity;
        } else {
          resource.quantityReserved -= value.quantity;
          resource.quantityDispatched += value.quantity;
        }
        break;

      case 'return':
        resource.quantityDispatched = Math.max(0, resource.quantityDispatched - value.quantity);
        break;

      case 'add_stock':
        resource.quantityTotal += value.quantity;
        break;

      case 'mark_damaged':
        if (value.quantity > resource.quantityTotal) {
          throw createError(`Cannot mark more than total stock (${resource.quantityTotal}) as damaged.`, 409);
        }
        resource.quantityTotal -= value.quantity;
        resource.quantityDamaged = (resource.quantityDamaged || 0) + value.quantity;
        break;
    }

    const actionMap = {
      reserve: 'reserved', dispatch: 'dispatched', add_stock: 'stock_added',
      return: 'returned', mark_damaged: 'damaged',
    };

    resource.movementHistory.push({
      action: actionMap[value.action],
      quantity: value.quantity,
      byUser: req.user._id,
      byUserName: req.user.displayName,
      incidentRef: value.incidentRef || null,
      note: value.note || null,
      timestamp: new Date(),
    });

    await resource.save({ session });
    await session.commitTransaction();

    await audit.record({
      actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
      action: `resource:${value.action}`, entityType: 'Resource',
      entityId: resource._id, entityRef: resource.ref,
      changes: { action: value.action, quantity: value.quantity, incidentRef: value.incidentRef },
      isDemo: resource.isDemo, ipAddress: req.ip,
    });

    const result = resource.toObject({ virtuals: true });
    res.json({ success: true, data: result });

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}));

module.exports = router;

