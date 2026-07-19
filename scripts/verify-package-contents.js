'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const EXPECTED_FILES = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'index.d.ts',
  'index.js',
  'package.json',
  'src/annotate.d.ts',
  'src/annotate.js',
];

const npmCommand = process.env.npm_execpath
  ? [process.execPath, process.env.npm_execpath]
  : [process.platform === 'win32' ? 'npm.cmd' : 'npm'];
const result = spawnSync(
  npmCommand[0],
  [...npmCommand.slice(1), 'pack', '--dry-run', '--json'],
  {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let packResults;
try {
  packResults = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`Could not parse npm pack output: ${error.message}`);
}

if (!Array.isArray(packResults)) {
  throw new Error('Expected npm pack output to be an array');
}
if (packResults.length !== 1) {
  throw new Error(`Expected one npm package, received ${packResults.length}`);
}

if (!Array.isArray(packResults[0].files)) {
  throw new Error('Expected npm pack output to include a files array');
}

const actualFiles = packResults[0].files.map(file => file.path).sort();
const missingFiles = EXPECTED_FILES.filter(file => !actualFiles.includes(file));
const unexpectedFiles = actualFiles.filter(file => !EXPECTED_FILES.includes(file));

if (missingFiles.length || unexpectedFiles.length) {
  const details = [
    missingFiles.length && `Missing: ${missingFiles.join(', ')}`,
    unexpectedFiles.length && `Unexpected: ${unexpectedFiles.join(', ')}`,
  ].filter(Boolean).join('\n');
  throw new Error(`Published package contents do not match the allowlist.\n${details}`);
}

console.log(`Verified ${actualFiles.length} published files.`);
