'use strict';

/**
 * Duplicate Detection Service
 * ----------------------------
 * Compares a new incident against existing ones using multiple signals:
 *   1. Category match
 *   2. Location token overlap
 *   3. Description text similarity (Jaccard on token sets)
 *   4. Geographic proximity (if coordinates are available)
 *   5. Time window (recent reports in same area are more likely related)
 *
 * Returns scored candidates — does NOT auto-merge or auto-tag.
 * Coordinators must review and confirm any link.
 */

const Incident = require('../models/Incident');

const SIMILARITY_THRESHOLD = 0.25;   // Minimum score to include in candidates
const STRONG_MATCH_THRESHOLD = 0.60; // Score above which to flag as possible_duplicate
const TIME_WINDOW_HOURS = 24;        // Only compare against recent incidents

// Tokenize a string into a set of meaningful lowercase tokens
function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s\u0C00-\u0C7F]/g, ' ') // allow Telugu chars
      .split(/\s+/)
      .filter(t => t.length > 2)
  );
}

// Jaccard similarity between two token sets
function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// Haversine distance in km between two lat/lng pairs
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find candidate duplicate/related incidents for a new report.
 *
 * @param {object} params
 * @param {string} params.locationDescription
 * @param {string} params.reportText
 * @param {string} params.category
 * @param {object|null} params.coordinates - { lat, lng }
 * @param {string|null} params.excludeId  - Incident ObjectId to exclude (self)
 * @param {boolean} params.isDemo         - If true, only compare against demo incidents
 * @returns {Promise<Array>} Scored candidate matches
 */
async function findCandidates({ locationDescription, reportText, category, coordinates, excludeId, isDemo }) {
  const cutoff = new Date(Date.now() - TIME_WINDOW_HOURS * 60 * 60 * 1000);

  // Fetch recent incidents from same demo/operational pool
  const query = {
    createdAt: { $gte: cutoff },
    status: { $nin: ['cancelled', 'closed'] },
    isDemo: Boolean(isDemo),
  };
  if (excludeId) query._id = { $ne: excludeId };

  const recent = await Incident.find(query)
    .select('_id ref locationDescription originalReport category coordinates createdAt effectiveUrgency status')
    .limit(200)
    .lean();

  if (!recent.length) {
    return [];
  }

  const newLocTokens = tokenize(locationDescription);
  const newMsgTokens = tokenize(reportText);

  const scored = [];

  for (const inc of recent) {
    const reasons = [];
    let score = 0;

    // 1. Category match
    if (inc.category && inc.category === category) {
      score += 0.2;
      reasons.push(`Same category: ${category}`);
    }

    // 2. Location token overlap
    const locSim = jaccard(newLocTokens, tokenize(inc.locationDescription));
    if (locSim > 0.3) {
      score += locSim * 0.3;
      reasons.push(`Location similarity ${(locSim * 100).toFixed(0)}%`);
    }

    // 3. Description text similarity
    const msgSim = jaccard(newMsgTokens, tokenize(inc.originalReport));
    if (msgSim > 0.15) {
      score += msgSim * 0.35;
      reasons.push(`Report text similarity ${(msgSim * 100).toFixed(0)}%`);
    }

    // 4. Geographic proximity
    if (coordinates && inc.coordinates && inc.coordinates.lat && inc.coordinates.lng) {
      const distKm = haversineKm(coordinates.lat, coordinates.lng, inc.coordinates.lat, inc.coordinates.lng);
      if (distKm < 1) {
        const proxScore = Math.max(0, 0.25 - distKm * 0.25);
        score += proxScore;
        reasons.push(`Within ${distKm.toFixed(2)} km`);
      }
    }

    // 5. Recency — reports within 3 hours in the same window get a small bonus
    const ageH = (Date.now() - new Date(inc.createdAt).getTime()) / 3600000;
    if (ageH < 3) {
      score += 0.05;
      reasons.push('Reported within past 3 hours');
    }

    if (score >= SIMILARITY_THRESHOLD) {
      scored.push({
        incidentId: inc._id,
        incidentRef: inc.ref,
        location: inc.locationDescription,
        summary: inc.originalReport.slice(0, 120),
        category: inc.category,
        urgency: inc.effectiveUrgency,
        status: inc.status,
        reportedAt: inc.createdAt,
        similarityScore: Math.min(1, score),
        matchReasons: reasons,
        duplicateTag: score >= STRONG_MATCH_THRESHOLD ? 'possible_duplicate' : 'related',
      });
    }
  }

  // Sort by descending similarity
  scored.sort((a, b) => b.similarityScore - a.similarityScore);
  return scored.slice(0, 5); // Return top-5 candidates
}

module.exports = { findCandidates };

