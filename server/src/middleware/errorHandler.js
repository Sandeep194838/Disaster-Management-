'use strict';

/**
 * Centralized error handler middleware.
 */

function errorHandler(err, _req, res, _next) {
  // Do NOT expose internal details in production
  const isDev = process.env.NODE_ENV === 'development';

  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'An unexpected error occurred.';

  // Mongoose validation errors
  if (err.name === 'ValidationError') {
    statusCode = 422;
    const errors = Object.values(err.errors).map(e => e.message);
    message = errors.join('; ');
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {}).join(', ');
    message = `Duplicate value for field: ${field}`;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid authentication token.';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Authentication token has expired. Please log in again.';
  }

  // Log only in non-test environments
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[Error ${statusCode}]`, isDev ? err.stack : message);
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(isDev && err.stack ? { stack: err.stack } : {}),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Wrap async route handlers to forward errors to the error handler.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create an HTTP error with a status code.
 */
function createError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, notFoundHandler, asyncHandler, createError };

