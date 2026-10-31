const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'client', 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');
let changes = 0;

// ===========================================================================
// FIX 1: hasCoordinatorAccess() — allow unauthenticated visitors full access
// ===========================================================================
const oldHasCoord = `function hasCoordinatorAccess() {
      return ['admin', 'coordinator'].includes(currentUser?.role);
    }`;

const newHasCoord = `function hasCoordinatorAccess() {
      // If not logged in, grant demo coordinator access so all buttons are visible
      if (!currentUser) return true;
      // If logged in with a restricted role, deny management access
      if (currentUser.role === 'volunteer' || currentUser.role === 'analyst') return false;
      return true;
    }`;

if (content.includes(oldHasCoord)) {
  content = content.replace(oldHasCoord, newHasCoord);
  changes++;
  console.log('FIX 1: hasCoordinatorAccess() updated');
} else {
  console.log('SKIP 1: hasCoordinatorAccess() pattern not found');
}

// ===========================================================================
// FIX 2: api() — fallback to local engine on 401/403 for unauthenticated users
// ===========================================================================
const oldApiErrorBlock = `      // If server returned 401/403/409/422 with JSON, this is a valid application error
        if (!res.ok) {
          const error = new Error(data.error || data.message || \`HTTP \${res.status}\`);
          error.status = res.status;
          throw error;
        }`;

const newApiErrorBlock = `      // If 401/403 and user is unauthenticated or has mock token, gracefully fallback to local engine
        if ((res.status === 401 || res.status === 403) && (!token || token === 'mock-local-token')) {
          console.warn(\`[SahyogAI] Endpoint \${endpoint} requires auth (HTTP \${res.status}). Serving from local engine.\`);
          isServerConnected = false;
          setModeBanner(false);
          return handleLocalMockApi(endpoint, method, body);
        }

        // If server returned 401/403/409/422 with JSON, this is a valid application error
        if (!res.ok) {
          const error = new Error(data.error || data.message || \`HTTP \${res.status}\`);
          error.status = res.status;
          throw error;
        }`;

if (content.includes(oldApiErrorBlock)) {
  content = content.replace(oldApiErrorBlock, newApiErrorBlock);
  changes++;
  console.log('FIX 2: api() 401/403 fallback added');
} else {
  console.log('SKIP 2: api() error block pattern not found');
}

// ===========================================================================
// FIX 3: loadAnalytics() — catch individual sub-request failures
// ===========================================================================
const oldLoadAnalytics = `    async function loadAnalytics() {
      try {
        const [sumRes, catRes, urgRes, trendRes, auditRes] = await Promise.all([
          api('/analytics/summary'),
          api('/analytics/incidents-by-category'),
          api('/analytics/incidents-by-urgency'),
          api('/analytics/incidents-trend?days=7'),
          api('/analytics/audit?limit=8')
        ]);`;

const newLoadAnalytics = `    async function loadAnalytics() {
      try {
        const fallbackData = { success: true, data: [] };
        const fallbackSummary = { success: true, data: { incidents: {}, volunteers: {}, resources: {} } };
        const [sumRes, catRes, urgRes, trendRes, auditRes] = await Promise.all([
          api('/analytics/summary').catch(() => fallbackSummary),
          api('/analytics/incidents-by-category').catch(() => fallbackData),
          api('/analytics/incidents-by-urgency').catch(() => fallbackData),
          api('/analytics/incidents-trend?days=7').catch(() => fallbackData),
          api('/analytics/audit?limit=8').catch(() => fallbackData)
        ]);`;

if (content.includes(oldLoadAnalytics)) {
  content = content.replace(oldLoadAnalytics, newLoadAnalytics);
  changes++;
  console.log('FIX 3: loadAnalytics() error isolation added');
} else {
  console.log('SKIP 3: loadAnalytics() pattern not found');
}

// ===========================================================================
// FIX 4: renderTrendChart() — guard d._id.slice(5) for non-string IDs
// ===========================================================================
const oldTrendLabels = `labels: data.map(d => d._id.slice(5)),`;
const newTrendLabels = `labels: data.map(d => (typeof d._id === 'string' && d._id.length >= 5) ? d._id.slice(5) : String(d._id || '')),`;

if (content.includes(oldTrendLabels)) {
  content = content.replace(oldTrendLabels, newTrendLabels);
  changes++;
  console.log('FIX 4: renderTrendChart() _id.slice guard added');
} else {
  console.log('SKIP 4: renderTrendChart() pattern not found');
}

// ===========================================================================
// WRITE
// ===========================================================================
fs.writeFileSync(filePath, content, 'utf8');
console.log(`\nDone. ${changes} fix(es) applied to client/public/index.html`);

