'use strict';

const app = require('../server/src/app');
const connectDB = require('../server/src/utils/db');
const { ensureDemoEnvironment } = require('../server/src/utils/demoEnvironment');

let dbConnectionPromise;

async function ensureDatabaseConnection() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured for this deployment.');
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured for this deployment.');
  }

  if (connectDB.isConnected()) return connectDB.connection;

  if (!dbConnectionPromise) {
    dbConnectionPromise = connectDB().finally(() => {
      dbConnectionPromise = null;
    });
  }

  return dbConnectionPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureDatabaseConnection();
    await ensureDemoEnvironment();
  } catch (err) {
    console.error('[Vercel Serverless] Database initialization failed:', err.message);
    return res.status(503).json({
      success: false,
      error: 'API configuration is incomplete or the database is unavailable. Verify JWT_SECRET, MONGODB_URI, and database access.',
    });
  }

  return app(req, res);
};
