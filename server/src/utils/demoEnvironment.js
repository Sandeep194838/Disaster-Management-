'use strict';

const User = require('../models/User');
const { seedDemoData } = require('../routes/demo');

const DEMO_ACCOUNTS = [
  { displayName: 'Admin (Demo)', username: 'admin', passwordHash: 'Admin@2024!', role: 'admin' },
  { displayName: 'Coordinator Lakshmi', username: 'coordinator', passwordHash: 'Coord@2024!', role: 'coordinator' },
];

let provisioningPromise;

async function createMissingDemoAccounts() {
  for (const account of DEMO_ACCOUNTS) {
    let existing = await User.findOne({ username: account.username }).select('+passwordHash');
    if (!existing) {
      try {
        existing = await User.create({ ...account, isDemo: false });
        console.log(`[Demo seed] Created ${account.role} account "${account.username}".`);
      } catch (error) {
        if (error.code !== 11000) throw error;
        existing = await User.findOne({ username: account.username }).select('+passwordHash');
        if (!existing) throw error;
      }
    }

    if (existing.role !== account.role) {
      throw new Error(`Cannot provision demo ${account.role} account: username "${account.username}" is already assigned to another role.`);
    }

    if (existing.displayName === account.displayName && !(await existing.comparePassword(account.passwordHash))) {
      existing.passwordHash = account.passwordHash;
      await existing.save();
      console.warn(`[Demo seed] Restored the default password for seeded ${account.role} account "${account.username}".`);
    }
  }
}

async function provisionDemoEnvironment() {
  await createMissingDemoAccounts();
  await seedDemoData();
}

function ensureDemoEnvironment() {
  if (process.env.DEMO_MODE !== 'true') return Promise.resolve(false);
  if (!provisioningPromise) {
    provisioningPromise = provisionDemoEnvironment().catch(error => {
      provisioningPromise = null;
      throw error;
    });
  }
  return provisioningPromise.then(() => true);
}

module.exports = { ensureDemoEnvironment, provisionDemoEnvironment };
