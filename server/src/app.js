'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const connectDB = require('./utils/db');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { setupSSE } = require('./utils/sse');

// ---- Route modules ----
const authRoutes = require('./routes/auth');
const incidentRoutes = require('./routes/incidents');
const volunteerRoutes = require('./routes/volunteers');
const resourceRoutes = require('./routes/resources');
const analyticsRoutes = require('./routes/analytics');
const demoRoutes = require('./routes/demo');

const app = express();

// ---- Security headers ----
app.use(helmet({
  contentSecurityPolicy: false, // disabled to allow Tailwind CDN in dev
  crossOriginEmbedderPolicy: false,
}));

// ---- CORS ----
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5000')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ---- Body parsing ----
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---- Logging ----
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ---- Global rate limiter ----
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please try again later.' },
});
app.use('/api/', globalLimiter);

// ---- Health check (unauthenticated) ----
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'SahyogAI API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    ai: process.env.GEMINI_API_KEY ? 'gemini-configured' : 'fallback-only',
    demo: process.env.DEMO_MODE === 'true',
  });
});

// ---- SSE broadcast endpoint ----
const sseRouter = setupSSE();
app.use('/api/events', sseRouter);

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/volunteers', volunteerRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/analytics', analyticsRoutes);

if (process.env.DEMO_MODE === 'true') {
  app.use('/api/demo', demoRoutes);
}

// ---- Serve frontend static files ----
const clientDir = path.join(__dirname, '../../client/public');
app.use(express.static(clientDir));

// ---- Catch-all: serve frontend SPA for non-API routes ----
app.get(/^(?!\/api).*$/, (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// ---- Error handling ----
app.use(notFoundHandler);
app.use(errorHandler);

// ---- Start server ----
const PORT = parseInt(process.env.PORT) || 5000;

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`\n🚀 SahyogAI API running on http://localhost:${PORT}`);
      console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
      console.log(`   AI Backend  : ${process.env.GEMINI_API_KEY ? '✅ Gemini configured' : '⚠️  Rule-based fallback only'}`);
      console.log(`   Demo Mode   : ${process.env.DEMO_MODE === 'true' ? '✅ Enabled' : '❌ Disabled'}\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

module.exports = app; // for testing

