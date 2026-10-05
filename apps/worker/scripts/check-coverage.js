import { spawn } from 'node:child_process';

const FLOOR = Number(process.env.WORKER_COVERAGE_FLOOR || 60);

console.log(`Running worker tests with experimental coverage (enforcing >= ${FLOOR}% line coverage)...`);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', '--test', '--experimental-test-coverage', 'src/**/*.test.ts', 'src/**/*.unit.spec.ts'],
  {
    cwd: process.cwd(),
    env: { ...process.env },
    shell: true,
  }
);

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => {
  const str = d.toString();
  stdout += str;
  process.stdout.write(str);
});

child.stderr.on('data', (d) => {
  const str = d.toString();
  stderr += str;
  process.stderr.write(str);
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`Worker tests failed with exit code ${code}`);
    process.exit(code || 1);
  }

  // Parse coverage report
  // Format: "ℹ all files | 74.55 | 84.51 | 62.62 |"
  const match = stdout.match(/all files\s*\|\s*([\d.]+)\s*\|/);
  if (!match) {
    console.error('Could not find "all files" coverage summary in output.');
    process.exit(1);
  }

  const lineCoverage = parseFloat(match[1]);
  console.log(`\nWorker Line Coverage: ${lineCoverage}% (Required Floor: ${FLOOR}%)`);

  if (lineCoverage < FLOOR) {
    console.error(`Worker coverage gate FAILED: ${lineCoverage}% is below the required floor of ${FLOOR}%`);
    process.exit(1);
  }

  console.log(`Worker coverage gate PASSED: ${lineCoverage}% >= ${FLOOR}%\n`);
});
