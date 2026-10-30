'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const ASSIGNMENT_STATUSES = [
  'pending',
  'sent',
  'acknowledged',
  'in_progress',
  'completed',
  'cancelled',
  'reassigned',
];

const assignmentSchema = new mongoose.Schema({
  ref: {
    type: String,
    unique: true,
    default: () => `ASN-${Date.now().toString(36).toUpperCase()}-${uuidv4().split('-')[0].toUpperCase()}`,
  },
  incident: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  incidentRef: String,
  volunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  volunteerName: String,
  assignedResources: [{
    resourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Resource' },
    resourceName: String,
    quantity: Number,
    unit: String,
  }],
  status: {
    type: String,
    enum: ASSIGNMENT_STATUSES,
    default: 'pending',
  },
  coordinatorNote: String,
  volunteerNote: String,
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedByName: String,
  acknowledgedAt: Date,
  startedAt: Date,
  completedAt: Date,
  isDemo: { type: Boolean, default: false },
}, {
  timestamps: true,
});

assignmentSchema.index({ incident: 1, status: 1 });
assignmentSchema.index({ volunteer: 1, status: 1 });

assignmentSchema.statics.STATUSES = ASSIGNMENT_STATUSES;

module.exports = mongoose.model('Assignment', assignmentSchema);

