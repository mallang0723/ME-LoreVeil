'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PATCHES, patchSource, checkVersion } = require('../runtime/ma-loreveil-runtime.cjs');
const { reference, entry, read } = require('./support/reference.cjs');
const hidden = '<div loreveil><ad-stat>Moonstone</ad-stat></div>';
const transform = (source, file) => patchSource(source, PATCHES.find(p => p.file.endsWith('/' + file)));

for (const version of ['2.5.1', '2.5.2']) {
  test(`${version}: fixture hashes and exact source anchors`, () => {
    const manifest = require('./fixtures/marinara/manifest.json').versions[version];
    for (const value of Object.values(manifest.files)) {
      assert.equal(crypto.createHash('sha256').update(read(value.fixture)).digest('hex'), value.sha256);
    }
    for (const patch of PATCHES) {
      const source = read(path.basename(patch.file));
      assert.notEqual(patchSource(source, patch), null);
      assert.equal(patchSource(source.replace(patch.anchor, 'changed'), patch), null);
      assert.equal(patchSource(source + '\n' + patch.anchor, patch), null);
      assert.equal(patchSource('// ' + patch.anchor + '\n', patch), null);
      const once = patchSource(source, patch);
      assert.equal(patchSource(once, patch), once);
      if (patch.replacement) {
        assert.equal(patchSource(once + '\n' + patch.replacement + '\n', patch), null);
        assert.equal(patchSource('// ' + patch.replacement + '\n', patch), null);
      }
    }
  });

  test(`${version}: chat exclusions, outside match, and immutable prompt input`, () => {
    const base = reference(version);
    const patched = reference(version, transform);
    for (const role of ['user', 'assistant', 'narrator']) {
      const messages = Object.freeze([Object.freeze({ role, content: hidden })]);
      assert.equal(base.scanForActivatedEntries(messages, [entry()]).length, 1);
      assert.equal(patched.scanForActivatedEntries(messages, [entry()]).length, 0);
      assert.equal(messages[0].content, hidden);
      assert.equal(patched.scanForActivatedEntries([{ role, content: hidden + ' Moonstone' }], [entry()]).length, 1);
    }
  });

  test(`${version}: pinned, per-entry depth, latest-user and secondary matching are masked`, () => {
    const patched = reference(version, transform);
    const messages = [{ role: 'user', content: hidden }];
    const pinned = Object.freeze([{ role: 'assistant', content: hidden }]);
    const options = Object.freeze({ scanDepth: 1, pinnedScanMessages: pinned });
    assert.equal(patched.scanForActivatedEntries([], [entry()], options).length, 0);
    assert.equal(options.pinnedScanMessages, pinned);
    for (const scanDepth of [null, 0, 1, 5]) {
      assert.equal(patched.scanForActivatedEntries(messages, [entry({ scanDepth })], options).length, 0);
    }
    const activation = patched.scanForActivatedEntries([
      { role: 'assistant', content: 'Moonstone' }, ...messages,
    ], [entry()]);
    assert.equal(activation.length, 1);
    assert.equal(activation[0].matchedCurrentContext, false);
    assert.equal(patched.scanForActivatedEntries([{ role: 'user', content: 'visible ' + hidden }],
      [entry({ keys: ['visible'], selective: true, secondaryKeys: ['Moonstone'] })]).length, 0);
    assert.equal(patched.scanForActivatedEntries([{ role: 'user', content: 'Moon<loreveil>x</loreveil>stone' }], [entry()]).length, 0);
  });

  test(`${version}: system sources and real recursive scan remain unchanged`, () => {
    const patched = reference(version, transform);
    assert.equal(patched.scanForActivatedEntries([{ role: 'system', content: hidden }], [entry()]).length, 1);
    const entries = [entry({ id: 'seed', keys: ['begin'], content: hidden }), entry()];
    const result = patched.recursiveScan([{ role: 'user', content: 'begin' }], entries);
    assert.deepEqual(result.map(a => a.entry.id), ['seed', 'keyword']);
    assert.equal(entries[0].content, hidden);
    assert.equal(patched.scanForActivatedEntries([{ role: 'user', content: hidden }], [entry({ constant: true })]).length, 1);
    assert.equal(patched.scanForActivatedEntries([], [entry({ additionalMatchingSources: ['character_description'] })], {
      additionalMatchingSourceText: { character_description: hidden },
    }).length, 1);
  });

  test(`${version}: semantic embedding payload masks user and assistant chat, not documents`, async () => {
    const calls = [];
    const patched = reference(version, transform, async (texts, options) => {
      calls.push({ texts, options });
      return texts.map(() => [1, 0, 0]);
    });
    const messages = Object.freeze([
      Object.freeze({ role: 'user', content: 'question ' + hidden }),
      Object.freeze({ role: 'assistant', content: 'answer ' + hidden }),
    ]);
    await patched.buildLorebookSemanticEmbeddingsById({
      lorebooks: [{ id: 'book', vectorQueryDepth: 2, vectorIncludeAssistant: true }],
      entries: [entry({ embedding: [1, 0, 0] })], scanMessages: messages,
      embeddingSource: { spaceId: 'fake' },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].texts.slice(0, 2), ['question', 'answer']);
    assert.equal(calls[0].options.inputType, 'query');
    assert.equal(messages[0].content, 'question ' + hidden);
    assert.equal(patched.selectLorebookVectorQueryText([{ role: 'user', content: hidden }], 2), '');
    assert.equal(patched.selectLorebookVectorQueryText([{ role: 'system', content: hidden }], 2), hidden);
    assert.ok(patched.buildLorebookEntryEmbeddingText(entry({ content: hidden })).includes(hidden));
  });

  test(`${version}: router query masks only chat; source context and summary are untouched`, () => {
    const patched = reference(version, transform);
    const context = Object.freeze({ recentMessages: Object.freeze([
      Object.freeze({ role: 'user', content: hidden }),
      Object.freeze({ role: 'assistant', content: 'visible ' + hidden }),
    ]), chatSummary: hidden, gameState: { location: 'test' } });
    assert.equal(patched.buildKnowledgeRouterQuery(context), hidden + '\n\nvisible\n\n{"location":"test"}');
    assert.equal(context.recentMessages[0].content, hidden);
  });
}

test('version gate requires both package identities and matching supported versions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loreveil-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'packages/server');
  fs.mkdirSync(server, { recursive: true });
  const write = (version, serverVersion = version, name = 'marinara-engine') => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify({ name: '@marinara-engine/server', version: serverVersion }));
  };
  for (const version of ['2.5.1', '2.5.2']) { write(version); assert.equal(checkVersion(server), null); }
  for (const version of ['2.5.3', '2.5.2-custom', '2.5.0', undefined]) { write(version); assert.ok(checkVersion(server)); }
  write('2.5.2', '2.5.1'); assert.ok(checkVersion(server));
  write('2.5.2', '2.5.2', 'other'); assert.ok(checkVersion(server));
  fs.writeFileSync(path.join(server, 'package.json'), '{broken'); assert.ok(checkVersion(server));
});
