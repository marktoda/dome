import { promises as fs } from 'fs';
import path from 'path';
import glob from 'fast-glob';

/**
 * Quick-and-dirty inventory of AgentState property access.
 *
 * - Scans all .ts files inside services/chat/src/nodes
 * - Collects every occurrence of `state.xxx`
 * - Guess whether it's a read or write (assignment or push etc.)
 * - Prints a summary table and JSON for further processing
 */
async function main() {
  const baseDir = path.resolve(__dirname, '../src/nodes');
  const files = await glob('**/*.ts', { cwd: baseDir, absolute: true });

  type Usage = { reads: number; writes: number; files: Set<string> };
  const usageMap: Record<string, Usage> = {};

  const readRegex = /state\.(\w+)/g;
  const writeRegex = /state\.(\w+)\s*=|state\.(\w+)\.push\s*\(|state\.(\w+)\.splice\s*\(/g;

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');

    // Collect reads (any access)
    let match: RegExpExecArray | null;
    while ((match = readRegex.exec(content))) {
      const prop = match[1];
      if (!usageMap[prop]) usageMap[prop] = { reads: 0, writes: 0, files: new Set() };
      usageMap[prop].reads += 1;
      usageMap[prop].files.add(path.relative(process.cwd(), file));
    }

    // Collect writes
    while ((match = writeRegex.exec(content))) {
      const prop = match[1] || match[2] || match[3];
      if (!prop) continue;
      if (!usageMap[prop]) usageMap[prop] = { reads: 0, writes: 0, files: new Set() };
      usageMap[prop].writes += 1;
      usageMap[prop].files.add(path.relative(process.cwd(), file));
    }
  }

  // Print summary table
  const entries = Object.entries(usageMap).sort((a, b) => b[1].reads + b[1].writes - (a[1].reads + a[1].writes));
  console.log('Property, Reads, Writes');
  for (const [prop, data] of entries) {
    console.log(`${prop}, ${data.reads}, ${data.writes}`);
  }

  // Write JSON snapshot
  const jsonPath = path.resolve(process.cwd(), 'state_usage_report.json');
  const jsonObj = Object.fromEntries(entries.map(([prop, data]) => [prop, { ...data, files: [...data.files] }]));
  await fs.writeFile(jsonPath, JSON.stringify(jsonObj, null, 2));
  console.log(`\nDetailed JSON report written to ${jsonPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 