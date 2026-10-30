'use strict';

const AuditEvent = require('../models/AuditEvent');

/**
 * Record an audit event. Failures are logged but never bubble up to the caller.
 */
async function record({ actor, actorName, actorRole, action, entityType, entityId, entityRef, changes, ipAddress, isDemo }) {
  try {
    await AuditEvent.create({
      actor: actor || null,
      actorName: actorName || 'System',
      actorRole: actorRole || null,
      action,
      entityType,
      entityId: entityId || null,
      entityRef: entityRef || null,
      changes: changes || null,
      ipAddress: ipAddress || null,
      isDemo: Boolean(isDemo),
    });
  } catch (err) {
    console.error('[AuditService] Failed to record audit event:', err.message);
  }
}

module.exports = { record };

