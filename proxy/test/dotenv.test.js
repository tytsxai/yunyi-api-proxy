import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDotEnvFiles, parseDotEnv } from '../lib/dotenv.js';

test('parseDotEnv: basic parsing + comments + export', () => {
  const parsed = parseDotEnv(`
# comment
FOO=bar # inline
BAR="baz # keep"
export ZED=1
EMPTY=
  `);

  assert.equal(parsed.FOO, 'bar');
  assert.equal(parsed.BAR, 'baz # keep');
  assert.equal(parsed.ZED, '1');
  assert.equal(parsed.EMPTY, '');
});

test('loadDotEnvFiles: later files override earlier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yunyi-dotenv-'));
  try {
    const a = join(dir, 'a.env');
    const b = join(dir, 'b.env');
    writeFileSync(a, 'K=1\nA=from_a\n', 'utf8');
    writeFileSync(b, 'K=2\nB=from_b\n', 'utf8');

    const cfg = loadDotEnvFiles([a, b, join(dir, 'missing.env')]);
    assert.deepEqual(cfg, { K: '2', A: 'from_a', B: 'from_b' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
