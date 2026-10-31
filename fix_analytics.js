const fs = require('fs');
let content = fs.readFileSync('server/src/routes/analytics.js', 'utf8');
const old = "router.get('/audit', authorize('admin', 'coordinator'), asyncHandler";
const rep = "router.get('/audit', authenticate, authorize('admin', 'coordinator'), asyncHandler";
if (content.includes(old)) {
  content = content.replace(old, rep);
  fs.writeFileSync('server/src/routes/analytics.js', content, 'utf8');
  console.log('OK: Added authenticate to audit route');
} else {
  console.log('SKIP: Pattern not found or already fixed');
}

