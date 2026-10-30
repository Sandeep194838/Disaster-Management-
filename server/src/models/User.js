'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'coordinator', 'volunteer', 'analyst'];

const userSchema = new mongoose.Schema({
  displayName: {
    type: String,
    required: [true, 'Display name is required.'],
    trim: true,
    maxlength: [100, 'Display name must be 100 characters or fewer.'],
  },
  username: {
    type: String,
    required: [true, 'Username is required.'],
    unique: true,
    lowercase: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters.'],
    maxlength: [50, 'Username must be 50 characters or fewer.'],
    match: [/^[a-z0-9_.-]+$/, 'Username may only contain letters, numbers, underscores, hyphens, and dots.'],
  },
  passwordHash: {
    type: String,
    required: true,
    select: false, // Never returned in queries by default
  },
  role: {
    type: String,
    enum: { values: ROLES, message: `Role must be one of: ${ROLES.join(', ')}.` },
    default: 'volunteer',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  isDemo: {
    type: Boolean,
    default: false,
  },
  // Volunteer-specific profile (optional)
  profile: {
    skills: [String],
    serviceArea: String,
    phone: { type: String, select: false }, // Restricted access
    teamAffiliation: String,
    availability: {
      type: String,
      enum: ['available', 'assigned', 'unavailable', 'off-duty'],
      default: 'available',
    },
    qualifications: [String],
  },
  lastSeen: Date,
}, {
  timestamps: true,
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.methods.toSafeObject = function() {
  return {
    id: this._id,
    displayName: this.displayName,
    username: this.username,
    role: this.role,
    isActive: this.isActive,
    profile: {
      skills: this.profile?.skills,
      serviceArea: this.profile?.serviceArea,
      teamAffiliation: this.profile?.teamAffiliation,
      availability: this.profile?.availability,
      qualifications: this.profile?.qualifications,
    },
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;

