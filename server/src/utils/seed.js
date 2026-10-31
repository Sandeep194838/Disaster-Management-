'use strict';

/**
 * Seed script — run with: npm run seed
 * Creates demo users and sample Visakhapatnam incident data.
 * ONLY run against a development or demo database.
 */

require('dotenv').config();
const connectDB = require('./db');
const { provisionDemoEnvironment } = require('./demoEnvironment');

async function main() {
  console.log('\n🌱 SahyogAI Demo Seed Script');
  console.log('   ⚠️  This will add demo data to:', process.env.MONGODB_URI);

  await connectDB();

  await provisionDemoEnvironment();
  console.log('\n🎉 Seed complete!\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
