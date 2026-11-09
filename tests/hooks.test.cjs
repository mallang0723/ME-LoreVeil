'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runHook } = require('./support/hook-harness.cjs');

for (const version of ['2.5.1', '2.5.2']) test(`${version}: real Node load hooks mask all five sites exactly once`, () => {
  const result = runHook({ version });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.data, { cleanActivated: 0, cleanSemantic: '', cleanRouter: '', cleanPrompt: 'Moonstone', activated: 0, semantic: '', router: '', unchanged: true, systemActivated: 1, memory: false });
  assert.equal((result.stderr.match(/\[loreveil\] applied:/g) ?? []).length, 5);
});

test('unsupported version skips every site and preserves original scanning', () => {
  const result = runHook({ version: '2.5.3' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.activated, 1);
  assert.equal(result.data.cleanActivated, 1);
  assert.ok(result.data.semantic.includes('Moonstone'));
  assert.equal((result.stderr.match(/\[loreveil\] fail closed:/g) ?? []).length, 5);
});

test('off switch leaves all sites untouched', () => {
  const result = runHook({ disabled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.activated, 1);
  assert.equal(result.data.cleanActivated, 1);
  assert.ok(result.data.semantic.includes('Moonstone'));
  assert.equal(result.stderr, '');
});

for (const brokenSite of ['request-scan-scope', 'prompt-regex-scan-view']) test(`${brokenSite} fails closed independently`, () => {
  const result = runHook({ brokenSite });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.activated, 0);
  assert.equal(result.data.cleanActivated, 1);
  assert.equal(result.data.cleanPrompt, 'Moonstone');
  assert.equal((result.stderr.match(/\[loreveil\] fail closed:/g) ?? []).length, 1);
  assert.equal((result.stderr.match(/\[loreveil\] applied:/g) ?? []).length, 4);
});

for (const mode of ['broken', 'duplicate']) test(`${mode} scanner anchor fails closed while semantic sites work`, () => {
  const result = runHook({ [mode]: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data.activated, 1);
  assert.equal(result.data.semantic, '');
  assert.equal(result.data.router, '');
  assert.equal((result.stderr.match(/\[loreveil\] fail closed:/g) ?? []).length, 1);
  assert.equal((result.stderr.match(/\[loreveil\] applied:/g) ?? []).length, 4);
});
