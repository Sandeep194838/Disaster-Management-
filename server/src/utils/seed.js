'use strict';

/**
 * Seed script — run with: npm run seed
 * Creates demo users and sample Visakhapatnam incident data.
 * ONLY run against a development or demo database.
 */

require('dotenv').config();
const connectDB = require('./db');
const User = require('../models/User');
const { seedDemoData } = require('../routes/demo');

async function main() {
  console.log('\n🌱 SahyogAI Demo Seed Script');
  console.log('   ⚠️  This will add demo data to:', process.env.MONGODB_URI);

  await connectDB();

  // Create coordinator & admin accounts
  const existingAdmin = await User.findOne({ username: 'admin' });
  if (!existingAdmin) {
    await User.create({
      displayName: 'Admin (Demo)',
      username: 'admin',
      passwordHash: 'Admin@2024!',
      role: 'admin',
      isDemo: false,
    });
    console.log('   ✅ Created admin account (admin / Admin@2024!)');
  } else {
    console.log('   ⚡ Admin account already exists — skipping.');
  }

  const existingCoord = await User.findOne({ username: 'coordinator' });
  if (!existingCoord) {
    await User.create({
      displayName: 'Coordinator Lakshmi',
      username: 'coordinator',
      passwordHash: 'Coord@2024!',
      role: 'coordinator',
      isDemo: false,
    });
    console.log('   ✅ Created coordinator account (coordinator / Coord@2024!)');
  } else {
    console.log('   ⚡ Coordinator account already exists — skipping.');
  }

  const existingAnalyst = await User.findOne({ username: 'analyst' });
  if (!existingAnalyst) {
    await User.create({
      displayName: 'Analyst Ravi',
      username: 'analyst',
      passwordHash: 'Analyst@2024!',
      role: 'analyst',
      isDemo: false,
    });
    console.log('   ✅ Created analyst account (analyst / Analyst@2024!)');
  } else {
    console.log('   ⚡ Analyst account already exists — skipping.');
  }

  // Seed demo incidents + resources + volunteers
  const { incidents, volunteers } = await seedDemoData();
  console.log(`   ✅ Seeded ${incidents.length} demo incidents`);
  console.log(`   ✅ Seeded ${volunteers.length} demo volunteers`);
  console.log('\n🎉 Seed complete!\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

