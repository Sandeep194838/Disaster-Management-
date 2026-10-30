'use strict';

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const RESOURCE_TYPES = [
  'Drinking Water',
  'Food Packets',
  'First-Aid Kits',
  'Medicines',
  'Blankets',
  'Temporary Shelters',
  'Rescue Equipment',
  'Boats',
  'Transport Vehicles',
  'Communication Equipment',
  'Baby Supplies',
  'Sanitation Kits',
  'Other',
];

const movementSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['stock_added', 'stock_updated', 'reserved', 'dispatched', 'delivered', 'returned', 'damaged', 'written_off'],
    required: true,
  },
  quantity: { type: Number, required: true },
  byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byUserName: String,
  incidentRef: String,
  assignmentRef: String,
  note: String,
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const resourceSchema = new mongoose.Schema({
  ref: {
    type: String,
    unique: true,
    default: () => `RES-${Date.now().toString(36).toUpperCase()}-${uuidv4().split('-')[0].toUpperCase()}`,
  },
  name: {
    type: String,
    required: [true, 'Resource name is required.'],
    trim: true,
    maxlength: [200, 'Resource name must be 200 characters or fewer.'],
  },
  resourceType: {
    type: String,
    enum: { values: RESOURCE_TYPES, message: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}.` },
    required: true,
  },
  unit: {
    type: String,
    required: [true, 'Unit is required (e.g., litres, packets, units).'],
    trim: true,
    maxlength: 50,
  },
  storageLocation: {
    type: String,
    trim: true,
    maxlength: 300,
  },
  responsibleOrg: {
    type: String,
    trim: true,
    maxlength: 200,
  },

  // Inventory quantities — all must be >= 0
  quantityTotal: { type: Number, default: 0, min: [0, 'Total quantity cannot be negative.'] },
  quantityReserved: { type: Number, default: 0, min: [0, 'Reserved quantity cannot be negative.'] },
  quantityDispatched: { type: Number, default: 0, min: [0, 'Dispatched quantity cannot be negative.'] },
  quantityDamaged: { type: Number, default: 0, min: [0, 'Damaged quantity cannot be negative.'] },

  lowStockThreshold: { type: Number, default: 10 },

  status: {
    type: String,
    enum: ['available', 'limited', 'out_of_stock', 'inactive'],
    default: 'available',
  },

  movementHistory: [movementSchema],
  isDemo: { type: Boolean, default: false },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// Virtual: quantity available = total - reserved - dispatched
resourceSchema.virtual('quantityAvailable').get(function () {
  return Math.max(0, this.quantityTotal - this.quantityReserved - this.quantityDispatched);
});

// Auto-compute status before save
resourceSchema.pre('save', function (next) {
  const available = this.quantityTotal - this.quantityReserved - this.quantityDispatched;
  if (available <= 0) this.status = 'out_of_stock';
  else if (available <= this.lowStockThreshold) this.status = 'limited';
  else this.status = 'available';
  next();
});

resourceSchema.index({ resourceType: 1, status: 1 });
resourceSchema.index({ isDemo: 1 });

resourceSchema.statics.RESOURCE_TYPES = RESOURCE_TYPES;

module.exports = mongoose.model('Resource', resourceSchema);
module.exports.RESOURCE_TYPES = RESOURCE_TYPES;

