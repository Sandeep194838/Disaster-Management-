'use strict';

const app = require('../server/src/app');
const connectDB = require('../server/src/utils/db');

let isDbConnecting = false;

module.exports = async (req, res) => {
  if (process.env.MONGODB_URI && !isDbConnecting) {
    try {
      isDbConnecting = true;
      await connectDB();
    } catch (err) {
      console.warn('[Vercel Serverless] MongoDB connection warning:', err.message);
    } finally {
      isDbConnecting = false;
    }
  }

  return app(req, res);
};

