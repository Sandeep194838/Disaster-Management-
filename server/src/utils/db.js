'use strict';

const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/sahyogai';

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 3000,
      socketTimeoutMS: 45000,
    });
    isConnected = true;
    console.log(`✅ MongoDB connected: ${mongoose.connection.host}`);
    return mongoose.connection;
  } catch (err) {
    console.error(`❌ MongoDB connection failed (${uri}): ${err.message}`);
    throw err;
  }
}

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err.message);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected.');
  isConnected = false;
});

module.exports = connectDB;
