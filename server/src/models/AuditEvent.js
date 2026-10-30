'use strict';

const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: { type: String, default: 'System' },
  actorRole: String,
  action: { type: String, required: true, maxlength: 100 },
  entityType: { type: String, required: true, enum: ['Incident', 'Assignment', 'Resource', 'User', 'System'] },
  entityId: mongoose.Schema.Types.ObjectId,
  entityRef: String,
  // Non-sensitive summary of what changed
  changes: mongoose.Schema.Types.Mixed,
  ipAddress: String,
  isDemo: { type: Boolean, default: false },
}, {
  timestamps: true,
});

auditSchema.index({ entityType: 1, entityId: 1 });
auditSchema.index({ actor: 1 });
auditSchema.index({ createdAt: -1 });
auditSchema.index({ action: 1 });

module.exports = mongoose.model('AuditEvent', auditSchema);

