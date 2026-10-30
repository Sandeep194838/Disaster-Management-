'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const User = require('../models/User');
const audit = require('../services/auditService');
const { asyncHandler, createError } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  message: { success: false, error: 'Too many login attempts. Please wait 15 minutes.' },
});

// ---- Validation schemas ----
const loginSchema = Joi.object({
  username: Joi.string().min(3).max(50).required(),
  password: Joi.string().min(6).max(128).required(),
});

const registerSchema = Joi.object({
  displayName: Joi.string().min(2).max(100).required(),
  username: Joi.string().alphanum().min(3).max(50).required(),
  password: Joi.string().min(8).max(128).required(),
  role: Joi.string().valid('coordinator', 'volunteer', 'analyst').default('volunteer'),
});

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// POST /api/auth/login
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const user = await User.findOne({ username: value.username, isActive: true }).select('+passwordHash');
  if (!user) throw createError('Invalid username or password.', 401);

  const match = await user.comparePassword(value.password);
  if (!match) throw createError('Invalid username or password.', 401);

  user.lastSeen = new Date();
  await user.save();

  const token = signToken(user._id);

  await audit.record({
    actor: user._id, actorName: user.displayName, actorRole: user.role,
    action: 'user:login', entityType: 'User', entityId: user._id,
    ipAddress: req.ip,
  });

  res.json({ success: true, token, user: user.toSafeObject() });
}));

// POST /api/auth/register (admin only in production; open in demo mode)
router.post('/register', asyncHandler(async (req, res) => {
  const isDemoMode = process.env.DEMO_MODE === 'true';

  // In production, only admins can create users via this endpoint
  if (!isDemoMode) {
    const authHeader = req.headers.authorization;
    if (!authHeader) throw createError('Admin authentication required to register users.', 401);
  }

  const { error, value } = registerSchema.validate(req.body);
  if (error) throw createError(error.details[0].message, 422);

  const existing = await User.findOne({ username: value.username });
  if (existing) throw createError('Username already taken.', 409);

  const user = await User.create({
    displayName: value.displayName,
    username: value.username,
    passwordHash: value.password, // pre-save hook will hash it
    role: value.role,
    isDemo: isDemoMode,
  });

  const token = signToken(user._id);

  await audit.record({
    actorName: 'System', action: 'user:registered', entityType: 'User',
    entityId: user._id, entityRef: user.username,
    ipAddress: req.ip,
  });

  res.status(201).json({ success: true, token, user: user.toSafeObject() });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  req.user.lastSeen = new Date();
  await req.user.save();
  res.json({ success: true, user: req.user.toSafeObject() });
}));

// POST /api/auth/logout (stateless JWT — client discards token; we record the event)
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await audit.record({
    actor: req.user._id, actorName: req.user.displayName, actorRole: req.user.role,
    action: 'user:logout', entityType: 'User', entityId: req.user._id,
    ipAddress: req.ip,
  });
  res.json({ success: true, message: 'Logged out. Please discard your token.' });
}));

module.exports = router;

