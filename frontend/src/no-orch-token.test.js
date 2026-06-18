// F17 security invariant: the orchestrator bearer token must NEVER live in the
// frontend. It belongs only in the Game_shelf backend env + Authorization header
// (F14). This scans the frontend source tree for the `ORCH_TOKEN` identifier.
// Excludes test files (and itself) so the literal here doesn't self-trip.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url)); // frontend/src
const FORBIDDEN = 'ORCH_TOKEN';
const SKIP_FILE = /\.test\.[jt]sx?$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|tsx?|mjs)$/.test(entry) && !SKIP_FILE.test(entry)) out.push(p);
  }
  return out;
}

describe('frontend never references the orchestrator token', () => {
  it(`no source file under src/ contains "${FORBIDDEN}"`, () => {
    const offenders = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(FORBIDDEN));
    expect(offenders).toEqual([]);
  });
});
