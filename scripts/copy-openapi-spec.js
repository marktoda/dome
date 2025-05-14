const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../openapi.json');
const destDir = path.resolve(__dirname, '../fern/openapi'); // Changed to fern/openapi
const destPath = path.resolve(destDir, 'openapi.json');

try {
  // Ensure destination directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    console.log(`Created directory: ${destDir}`);
  }
  fs.copyFileSync(sourcePath, destPath);
  console.log(`Copied ${sourcePath} to ${destPath}`);
} catch (err) {
  console.error(`Error copying openapi.json: ${err.message}`);
  process.exit(1);
}
