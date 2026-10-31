const fs = require('fs');
const filePath = 'server/src/routes/analytics.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace the old router.use line that requires authenticate + authorize on ALL routes
const oldPattern = "// Only coordinators, analysts, admins can see analytics\r\nrouter.use(authenticate, authorize('admin', 'coordinator', 'analyst'));";
const newPattern = "// Allow unauthenticated read access to analytics; audit route requires coordinator+\r\nrouter.use(optionalAuth);";

if (content.includes(oldPattern)) {
  content = content.replace(oldPattern, newPattern);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('OK: Replaced router.use(authenticate, authorize) with router.use(optionalAuth)');
} else {
  console.log('Pattern not found. Checking for alternative...');
  // Maybe without \r\n
  const oldAlt = "// Only coordinators, analysts, admins can see analytics\nrouter.use(authenticate, authorize('admin', 'coordinator', 'analyst'));";
  if (content.includes(oldAlt)) {
    content = content.replace(oldAlt, "// Allow unauthenticated read access to analytics; audit route requires coordinator+\nrouter.use(optionalAuth);");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('OK (alt): Replaced with \\n line endings');
  } else {
    console.log('Neither pattern found. File may already be fixed.');
  }
}

// Verify
const updated = fs.readFileSync(filePath, 'utf8');
console.log('Has optionalAuth middleware line:', updated.includes('router.use(optionalAuth)'));
console.log('Still has old authenticate line:', updated.includes("router.use(authenticate, authorize('admin'"));

