/**
 * Every suite, one command:
 *
 *   node C:\DevClaude\hive-pocket\tests\run-all.js
 *   node C:\DevClaude\hive-pocket\tests\run-all.js -v     (every line each suite printed)
 *
 * DISCOVERED, NOT LISTED. It globs *-smoke.js in this folder rather than naming them, because a
 * runner with a hardcoded list is a runner that silently stops covering the fifth suite somebody
 * adds — and a suite nobody runs is worse than no suite, since it still reads as coverage.
 *
 * SEPARATE PROCESSES, on purpose. Each suite ends in process.exit() and each boots the app into
 * its own vm sandbox with its own timers; running them in one process would let the first one to
 * finish take the rest down with it. The cost is a Node start per suite, which is about a tenth
 * of a second against suites that take seconds.
 *
 * A SUITE THAT CRASHES IS A FAILURE, not a missing line. If a file throws at load, prints
 * nothing, or exits without a count, that is reported as a failure with its exit code rather
 * than skipped — the failure mode this is guarding against is a green summary that quietly
 * covers less than it did yesterday.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const verbose = process.argv.slice(2).some((a) => a === '-v' || a === '--verbose');
const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => /-smoke\.js$/.test(f)).sort();

if (!files.length) {
  console.log('no *-smoke.js in ' + dir + ' - nothing ran, which is not the same as nothing wrong');
  process.exit(1);
}

let totalPass = 0, totalFail = 0, broken = 0;
const rows = [];
const started = Date.now();

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (verbose) { console.log('\n=== ' + f + ' ===\n' + out.trim()); }
  // The last count the suite printed. Matching the last one rather than the first means a suite
  // that prints a count mid-run cannot flatter the total.
  const counts = out.match(/(\d+) passed, (\d+) failed/g) || [];
  const last = counts.length ? counts[counts.length - 1].match(/(\d+) passed, (\d+) failed/) : null;
  if (!last) {
    broken++;
    rows.push({ f, note: 'NO RESULT (exit ' + r.status + ')' });
    if (!verbose && out.trim()) console.log('\n=== ' + f + ' ===\n' + out.trim());
    continue;
  }
  const pass = Number(last[1]), fail = Number(last[2]);
  totalPass += pass; totalFail += fail;
  rows.push({ f, pass, fail });
  // A suite with failures gets its output shown even without -v: the point of running is to read
  // the failure, and making someone re-run with a flag to see it is one step too many.
  if (fail && !verbose) {
    console.log('\n=== ' + f + ' ===');
    out.split('\n').filter((l) => /FAIL|failed/.test(l)).forEach((l) => console.log(l));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('');
for (const r of rows) {
  const name = r.f.replace(/-smoke\.js$/, '').padEnd(10);
  console.log('  ' + name + (r.note ? r.note : r.pass + ' passed, ' + r.fail + ' failed'));
}
console.log('');
console.log('  ' + files.length + ' suites, ' + totalPass + ' passed, ' + totalFail + ' failed'
  + (broken ? ', ' + broken + ' produced no result' : '') + ', ' + secs + 's');
console.log('');
process.exit(totalFail || broken ? 1 : 0);
