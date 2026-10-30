'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { createError, asyncHandler } = require('./errorHandler');

/**
 * Verify JWT and attach user to req.user.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw createError('Authentication required. Please provide a Bearer token.', 401);
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw err; // Let errorHandler classify JWT errors
  }

  const user = await User.findById(decoded.id).select('-passwordHash');
  if (!user || !user.isActive) {
    throw createError('Account not found or deactivated.', 401);
  }

  req.user = user;
  next();
});

/**
 * Require one of the specified roles.
 * @param {...string} roles
 */
function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(createError('Authentication required.', 401));
    }
    if (!roles.includes(req.user.role)) {
      return next(createError(`Access denied. Required role(s): ${roles.join(', ')}.`, 403));
    }
    next();
  };
}

/**
 * Optional authentication — attaches user if token is present and valid,
 * but does not block unauthenticated requests.
 */
const optionalAuth = asyncHandler(async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-passwordHash');
      if (user && user.isActive) req.user = user;
    }
  } catch (_err) {
    // Silently ignore — optional auth
  }
  next();
});

module.exports = { authenticate, authorize, optionalAuth };

