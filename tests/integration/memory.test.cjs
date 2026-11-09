'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook } = require('../support/hook-harness.cjs');
const memory = process.env.LOREVEIL_MEMORY_RUNTIME;

test('memory reference runtime is supplied explicitly', () => {
  assert.ok(memory && path.isAbsolute(memory) && fs.existsSync(memory), 'Set LOREVEIL_MEMORY_RUNTIME to the extracted 8d5f090 runtime');
});
test('all LoreVeil files are disjoint from memory runtime patch targets', () => {
  assert.ok(memory, 'LOREVEIL_MEMORY_RUNTIME required');
  const previous = process.env.MEMORY_MODULE_HOOK_TEST;
  process.env.MEMORY_MODULE_HOOK_TEST = '1';
  try {
    const memoryPatches = require(memory).PATCHES;
    const loreveilPatches = require('../../runtime/ma-loreveil-runtime.cjs').PATCHES;
    for (const patch of loreveilPatches) {
      assert.equal(memoryPatches.some(other => other.target.test('/app/packages/server/dist/' + patch.file)), false);
    }
  } finally {
    if (previous === undefined) delete process.env.MEMORY_MODULE_HOOK_TEST;
    else process.env.MEMORY_MODULE_HOOK_TEST = previous;
  }
});
for (const version of ['2.5.1', '2.5.2']) for (const order of ['first', 'last']) {
  test(`${version}: LoreVeil ${order} in --require order with real memory runtime`, () => {
    assert.ok(memory, 'LOREVEIL_MEMORY_RUNTIME required');
    const result = runHook({ memory, version, order });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.data, { cleanActivated: 0, cleanSemantic: '', cleanRouter: '', cleanPrompt: 'Moonstone', activated: 0, semantic: '', router: '', unchanged: true, systemActivated: 1, memory: true });
    assert.match(result.stderr, /\[memory-module\].*applied:.*macro ready/);
    assert.equal((result.stderr.match(/\[loreveil\] applied:/g) ?? []).length, 5);
  });
}
