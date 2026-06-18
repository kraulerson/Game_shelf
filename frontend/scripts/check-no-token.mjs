// Post-build guard: fail if the built bundle (frontend/dist) contains the
// orchestrator token identifier or its literal value. Run AFTER `vite build`.
//   node scripts/check-no-token.mjs
// If ORCH_TOKEN is set in the environment, its literal value is also checked.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const tokenValue = process.env.ORCH_TOKEN;
const needles = ['ORCH_TOKEN'];
if (tokenValue && tokenValue.length >= 8) needles.push(tokenValue);

if (!existsSync(DIST)) {
  console.error(`check-no-token: ${DIST}/ not found — run \`vite build\` first.`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(DIST)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary/unreadable asset — skip
  }
  for (const needle of needles) {
    if (text.includes(needle)) {
      const shown = needle === tokenValue ? '<ORCH_TOKEN value>' : needle;
      offenders.push(`${file} contains "${shown}"`);
    }
  }
}

if (offenders.length) {
  console.error('check-no-token: FAIL — orchestrator token leaked into the frontend bundle:');
  for (const o of offenders) console.error(`  - ${o}`);
  process.exit(1);
}
console.log('check-no-token: OK — no orchestrator token in the built bundle.');
