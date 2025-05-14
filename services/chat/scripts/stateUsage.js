const fs = require('fs/promises');
const path = require('path');
const glob = require('fast-glob');

(async () => {
  const baseDir = path.resolve(__dirname, '../src/nodes');
  const files = await glob('**/*.ts', { cwd: baseDir, absolute: true });

  /** @type {Record<string, {reads:number, writes:number, files:Set<string>}>>} */
  const usageMap = {};

  const readRegex = /state\.(\w+)/g;
  const writeRegex = /state\.(\w+)\s*=|state\.(\w+)\.push\s*\(|state\.(\w+)\.splice\s*\(/g;

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    let match;
    while ((match = readRegex.exec(content))) {
      const prop = match[1];
      if (!usageMap[prop]) usageMap[prop] = { reads: 0, writes: 0, files: new Set() };
      usageMap[prop].reads++;
      usageMap[prop].files.add(path.relative(process.cwd(), file));
    }
    while ((match = writeRegex.exec(content))) {
      const prop = match[1] || match[2] || match[3];
      if (!prop) continue;
      if (!usageMap[prop]) usageMap[prop] = { reads: 0, writes: 0, files: new Set() };
      usageMap[prop].writes++;
      usageMap[prop].files.add(path.relative(process.cwd(), file));
    }
  }

  const entries = Object.entries(usageMap).sort((a, b) => (b[1].reads + b[1].writes) - (a[1].reads + a[1].writes));
  console.log('Property, Reads, Writes');
  entries.forEach(([prop, data]) => {
    console.log(`${prop}, ${data.reads}, ${data.writes}`);
  });

  const json = Object.fromEntries(entries.map(([prop, data]) => [prop, { ...data, files: [...data.files] }]));
  const outPath = path.resolve(process.cwd(), 'state_usage_report.json');
  await fs.writeFile(outPath, JSON.stringify(json, null, 2));
  console.log(`\nJSON report written to ${outPath}`);
})(); 