'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// ---- Enums / constants ----
const URGENCY_LEVELS = ['Critical', 'High', 'Medium', 'Low'];
const CATEGORIES = [
  'Medical Emergency',
  'Trapped / Missing People',
  'Flooding',
  'Fire',
  'Food & Drinking Water',
  'Shelter',
  'Rescue Assistance',
  'Transportation',
  'Power Outage',
  'Communication Failure',
  'Sanitation',
  'Roadblock & Fallen Trees',
  'Other Emergency',
];
const INCIDENT_STATUSES = [
  'submitted',
  'under_review',
  'verified',
  'awaiting_assignment',
  'assigned',
  'acknowledged',
  'in_progress',
  'assistance_delivered',
  'resolved',
  'closed',
  'cancelled',
];
const DUPLICATE_TAGS = ['none', 'possible_duplicate', 'related', 'confirmed_duplicate', 'independent'];

// ---- Sub-schemas ----
const coordinatesSchema = new mongoose.Schema({
  lat: { type: Number, min: -90, max: 90 },
  lng: { type: Number, min: -180, max: 180 },
  accuracy: Number, // meters
  source: {
    type: String,
    enum: ['gps', 'geocoded', 'manual', 'approximate'],
    default: 'manual',
  },
}, { _id: false });

const statusHistorySchema = new mongoose.Schema({
  status: { type: String, enum: INCIDENT_STATUSES },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  changedByName: String,
  note: String,
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const aiTriageSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['gemini', 'fallback', 'pending'],
    default: 'pending',
  },
  model: String,
  recommendedUrgency: { type: String, enum: [...URGENCY_LEVELS, null] },
  recommendedCategory: String,
  incidentTitle: String,
  summary: String,
  affectedCount: Number,
  immediateNeeds: [String],
  hazards: [String],
  recommendedNextSteps: [String],
  missingInfo: [String],
  confidence: { type: String, enum: ['high', 'medium', 'low', 'uncertain'] },
  reasoning: String,
  detectedLanguage: String,
  rawResponse: mongoose.Schema.Types.Mixed,
  processedAt: Date,
  processingMs: Number,
}, { _id: false });

const duplicateCheckSchema = new mongoose.Schema({
  performedAt: Date,
  candidateMatches: [{
    incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident' },
    incidentRef: String,
    similarityScore: Number,
    matchReasons: [String],
    duplicateTag: { type: String, enum: DUPLICATE_TAGS, default: 'possible_duplicate' },
  }],
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
}, { _id: false });

// ---- Main schema ----
const incidentSchema = new mongoose.Schema({
  // Unique human-readable reference
  ref: {
    type: String,
    unique: true,
    default: () => `INC-${Date.now().toString(36).toUpperCase()}-${uuidv4().split('-')[0].toUpperCase()}`,
  },

  // Original report
  originalReport: {
    type: String,
    required: [true, 'Emergency description is required.'],
    trim: true,
    maxlength: [5000, 'Report must be 5000 characters or fewer.'],
  },
  detectedLanguage: String,

  // Location
  locationDescription: {
    type: String,
    required: [true, 'Location description is required.'],
    trim: true,
    maxlength: [500, 'Location description must be 500 characters or fewer.'],
  },
  coordinates: coordinatesSchema,
  locationVerificationStatus: {
    type: String,
    enum: ['reported', 'geocoded', 'field_verified', 'unverified'],
    default: 'reported',
  },

  // Category & urgency
  reportedCategory: { type: String, enum: [...CATEGORIES, null] },
  category: { type: String, enum: [...CATEGORIES, null] },
  
  aiRecommendedUrgency: { type: String, enum: [...URGENCY_LEVELS, null] },
  coordinatorUrgency: { type: String, enum: [...URGENCY_LEVELS, null] },
  urgencyOverriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  urgencyOverriddenAt: Date,
  urgencyOverrideReason: String,

  // Effective urgency = coordinatorUrgency ?? aiRecommendedUrgency ?? 'Medium'
  effectiveUrgency: { type: String, enum: URGENCY_LEVELS, default: 'Medium' },

  // AI triage
  aiTriage: aiTriageSchema,
  triageStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    default: 'pending',
  },

  // Duplicate detection
  duplicateCheck: duplicateCheckSchema,
  duplicateTag: { type: String, enum: DUPLICATE_TAGS, default: 'none' },
  relatedIncidents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Incident' }],

  // People
  affectedCount: Number,
  affectedCountRange: String, // e.g. "4-8"
  contactPhone: { type: String, select: false }, // Restricted
  contactName: { type: String, select: false }, // Restricted

  // Required resources
  requiredResources: [String],

  // Status
  status: {
    type: String,
    enum: INCIDENT_STATUSES,
    default: 'submitted',
    index: true,
  },
  statusHistory: [statusHistorySchema],

  // Assignments
  assignments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }],

  // Verification
  verificationStatus: {
    type: String,
    enum: ['unverified', 'under_review', 'verified', 'false_alarm'],
    default: 'unverified',
  },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,

  // Audit
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reportedByName: String,
  isDemo: { type: Boolean, default: false },
  isAnonymous: { type: Boolean, default: true },

  // Resolution
  resolutionNote: String,
  closedAt: Date,

  // Image attachments
  attachments: [{
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now },
  }],
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// ---- Indexes ----
incidentSchema.index({ effectiveUrgency: 1, status: 1, createdAt: -1 });
incidentSchema.index({ locationDescription: 'text', originalReport: 'text' });
incidentSchema.index({ category: 1 });
incidentSchema.index({ isDemo: 1 });
incidentSchema.index({ createdAt: -1 });

// ---- Pre-save: compute effectiveUrgency ----
incidentSchema.pre('save', function(next) {
  this.effectiveUrgency = this.coordinatorUrgency || this.aiRecommendedUrgency || 'Medium';
  next();
});

// ---- Statics ----
incidentSchema.statics.URGENCY_LEVELS = URGENCY_LEVELS;
incidentSchema.statics.CATEGORIES = CATEGORIES;
incidentSchema.statics.INCIDENT_STATUSES = INCIDENT_STATUSES;
incidentSchema.statics.DUPLICATE_TAGS = DUPLICATE_TAGS;

module.exports = mongoose.model('Incident', incidentSchema);
module.exports.URGENCY_LEVELS = URGENCY_LEVELS;
module.exports.CATEGORIES = CATEGORIES;
module.exports.INCIDENT_STATUSES = INCIDENT_STATUSES;

