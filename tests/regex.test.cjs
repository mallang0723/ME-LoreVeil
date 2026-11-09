'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const { PATCHES, patchSource } = require('../runtime/ma-loreveil-runtime.cjs');
const { createScanBridge } = require('../lib/regex-scan-view.cjs');
const { reference, entry, cleanHTML } = require('./support/reference.cjs');
const { requestHarness } = require('./support/request-scope.cjs');
const runtime = globalThis[Symbol.for('ma-loreveil.runtime.v1')];
const transform = (source, file) => patchSource(source, PATCHES.find(p => p.file.endsWith('/' + file)));
const hidden = '<div loreveil><ad-stat>Moonstone</ad-stat></div>';
const script = (findRegex, replaceString, extra = {}) => ({ ...cleanHTML, findRegex, replaceString, ...extra });

for (const version of ['2.5.1', '2.5.2']) {
  const base = reference(version);
  const patched = reference(version, transform);
  const requests = requestHarness(runtime.attachRequestScope);
  test(`${version}: default Clean HTML preserves prompt and stored text; keyword, pinned and semantic views exclude`, async () => {
    await requests.run(async () => {
      for (const role of ['user', 'assistant', 'narrator']) {
        const stored = Object.freeze({ role, content: 'Continue the scene. ' + hidden });
        const prompt = [{ ...stored }];
        const baseline = [{ ...stored }];
        base.applyRegexScriptsToPromptMessages(baseline, [cleanHTML]);
        patched.applyRegexScriptsToPromptMessages(prompt, [cleanHTML]);
        assert.deepEqual(prompt, baseline);
        assert.equal(prompt[0].content, 'Continue the scene. Moonstone');
        assert.equal(stored.content, 'Continue the scene. ' + hidden);
        await tick();
        // The route discards message identity and keeps only role/content.
        const scan = prompt.map(m => ({ role: m.role, content: m.content }));
        assert.equal(base.scanForActivatedEntries(scan, [entry()]).length, 1);
        assert.equal(patched.scanForActivatedEntries(scan, [entry()]).length, 0);
        assert.equal(patched.scanForActivatedEntries([], [entry()], { pinnedScanMessages: scan }).length, 0);
        assert.equal(patched.selectLorebookVectorQueryText(scan, 2).trim(), 'Continue the scene.');
        assert.equal(patched.buildKnowledgeRouterQuery({ recentMessages: scan }).trim(), 'Continue the scene.');
      }
      const recursive = [{ role: 'system', content: 'Continue the scene. Moonstone' }];
      assert.equal(patched.scanForActivatedEntries(recursive, [entry()]).length, 1);
    });
  });

  test(`${version}: custom regex removes or rewrites every marker form; outside replacements still match`, async () => {
    const cases = [
      [hidden, [script('loreveil', 'data-status')]],
      ['<loreveil>Moonstone</loreveil>', [script('loreveil', 'status')]],
      ['!--LOREVEIL_START--!Moonstone!--LOREVEIL_END--!', [script('!--LOREVEIL_(?:START|END)--!', '')]],
      [hidden, [cleanHTML, script('Moonstone', 'Gemstone')]],
    ];
    for (const [content, scripts] of cases) await requests.run(() => {
      for (const outside of ['', ' Moonstone']) {
        const input = [{ role: 'user', content: content + outside }];
        const baseline = structuredClone(input);
        base.applyRegexScriptsToPromptMessages(baseline, scripts);
        patched.applyRegexScriptsToPromptMessages(input, scripts);
        assert.deepEqual(input, baseline);
        assert.equal(patched.scanForActivatedEntries(input, [entry({ keys: ['Moonstone', 'Gemstone'] })]).length, outside ? 1 : 0);
      }
    });
  });

  test(`${version}: script selection, depth, targeting and trim use upstream semantics`, async () => {
    await requests.run(() => {
      const scripts = [
        script('loreveil', 'status', { applyMode: 'display' }),
        script('outside', 'Moonstone', { enabled: false }),
        script('outside', 'Moonstone', { minDepth: 2 }),
        script('outside', 'Moonstone', { targetCharacterIds: ['other'] }),
        script('outside', 'Moonstone', { targetPromptPresetIds: ['other'] }),
        { ...cleanHTML, trimStrings: ['trim-me'] },
        script('outside', 'Gemstone', { maxDepth: 1, targetCharacterIds: ['char'], targetPromptPresetIds: ['preset'] }),
      ];
      const prompt = [{ id: 'msg', role: 'user', content: 'outside trim-me ' + hidden }];
      const baseline = structuredClone(prompt);
      const options = { targetCharacterId: 'char', targetPromptPresetId: 'preset' };
      base.applyRegexScriptsToPromptMessages(baseline, scripts, options);
      patched.applyRegexScriptsToPromptMessages(prompt, scripts, options);
      assert.deepEqual(prompt, baseline);
      const query = patched.selectLorebookVectorQueryText(prompt, 2);
      assert.equal(query, 'Gemstone');
    });
  });

  test(`${version}: regex macro resolver runs only on the prompt path with original random seed`, async () => {
    await requests.run(() => {
      const scripts = [cleanHTML, script('{{find}}', '{{replace}}', { trimStrings: ['{{trim}}'] })];
      const input = [{ id: 'msg', role: 'user', content: 'outside ' + hidden }];
      const baseline = structuredClone(input);
      const calls = [];
      const baseCalls = [];
      const resolve = sink => (value, seed) => {
        sink.push([value, seed]);
        return ({ '{{find}}': 'outside', '{{replace}}': 'visible', '{{trim}}': 'never' })[value];
      };
      base.applyRegexScriptsToPromptMessages(baseline, scripts, { resolveMacros: resolve(baseCalls) });
      patched.applyRegexScriptsToPromptMessages(input, scripts, { resolveMacros: resolve(calls) });
      assert.deepEqual(input, baseline);
      assert.deepEqual(calls, baseCalls);
      assert.equal(patched.selectLorebookVectorQueryText(input, 2), 'visible');
    });
  });

  test(`${version}: simultaneous requests with the same request-id and prompt output stay isolated`, async () => {
    await Promise.all([true, false].map(excluded => requests.run(async () => {
      const prompt = [{ role: 'user', content: excluded ? hidden : 'Moonstone' }];
      patched.applyRegexScriptsToPromptMessages(prompt, [cleanHTML]);
      await tick();
      assert.equal(patched.scanForActivatedEntries(prompt, [entry()]).length, excluded ? 0 : 1);
    })));
    assert.equal(patched.scanForActivatedEntries([{ role: 'user', content: 'Moonstone' }], [entry()]).length, 1);
  });

  test(`${version}: post-regex blank-line normalization and repeated transforms retain scan view`, async () => {
    await requests.run(() => {
      const prompt = [{ role: 'user', content: 'visible\n \n\n' + hidden }];
      patched.applyRegexScriptsToPromptMessages(prompt, [cleanHTML]);
      patched.applyRegexScriptsToPromptMessages(prompt, [script('visible', 'changed')]);
      prompt[0].content = prompt[0].content.replace(/\n([ \t]*\n){2,}/g, '\n\n');
      assert.equal(patched.scanForActivatedEntries(prompt, [entry()]).length, 0);
      assert.equal(patched.selectLorebookVectorQueryText(prompt, 2), 'changed');
    });
  });
}

test('same-request output collisions fail closed in either observation order', async () => {
  for (const reverse of [false, true]) {
    const logs = [];
    const bridge = createScanBridge(line => logs.push(line));
    const requests = requestHarness(bridge.attachRequestScope);
    const { applyRegexScriptsToPromptText: apply } = reference();
    await requests.run(() => {
      const messages = [hidden, 'Moonstone'].map(content => ({ role: 'user', content }));
      if (reverse) messages.reverse();
      for (const m of messages) m.content = bridge.regexText(m, [cleanHTML], 'user_input', 0, {}, apply);
      assert.equal(bridge.messages(messages), messages);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /fail closed:.*ambiguous regex output/);
    });
  }
});

test('response and abort clear mappings even for descendants still running in the old async context', async () => {
  for (const aborted of [false, true]) {
    const bridge = createScanBridge();
    const requests = requestHarness(bridge.attachRequestScope);
    const { applyRegexScriptsToPromptText: apply } = reference();
    await requests.run(async request => {
      const m = { role: 'user', content: hidden };
      m.content = bridge.regexText(m, [cleanHTML], 'user_input', 0, {}, apply);
      assert.equal(bridge.messages([m])[0].content, '');
      requests.finish(request, aborted);
      await tick();
      assert.equal(bridge.messages([m])[0].content, 'Moonstone');
    });
  }
});

test('request size limit disables the bridge without changing prompt or crashing', async () => {
  const logs = [];
  const bridge = createScanBridge(line => logs.push(line));
  const requests = requestHarness(bridge.attachRequestScope);
  const { applyRegexScriptsToPromptText: apply } = reference();
  await requests.run(() => {
    for (let i = 0; i <= 4096; i++) {
      const m = { role: 'user', content: i + hidden };
      const output = bridge.regexText(m, [cleanHTML], 'user_input', 0, {}, apply);
      assert.equal(output, i + 'Moonstone');
    }
    assert.equal(bridge.messages([{ role: 'user', content: '0Moonstone' }])[0].content, '0Moonstone');
    assert.match(logs.join('\n'), /request scan-view limit reached/);
  });
});

test('unmarked prompt messages retain string, object and array identity even with blank lines', async () => {
  const bridge = createScanBridge();
  const requests = requestHarness(bridge.attachRequestScope);
  const { applyRegexScriptsToPromptText: apply } = reference();
  await requests.run(() => {
    const messages = [{ role: 'user', content: 'visible\n\n\ntext' }];
    const original = messages[0].content;
    messages[0].content = bridge.regexText(messages[0], [cleanHTML], 'user_input', 0, {}, apply);
    assert.equal(messages[0].content, original);
    assert.equal(bridge.messages(messages), messages);
  });
});

test('shadow exceptions and unavailable macro replay fail closed without rerunning prompt macros', async () => {
  for (const mode of ['throw', 'macro']) {
    const logs = [];
    const bridge = createScanBridge(line => logs.push(line));
    const requests = requestHarness(bridge.attachRequestScope);
    await requests.run(() => {
      const message = { role: 'user', content: hidden };
      let macroCalls = 0;
      let applyCalls = 0;
      const apply = (text, _scripts, _placement, _depth, options) => {
        applyCalls++;
        if (!text && mode === 'throw') throw new Error('shadow only');
        options.resolveMacros(text ? 'prompt' : 'shadow', 'seed');
        return text ? 'Moonstone' : '';
      };
      message.content = bridge.regexText(message, [], 'user_input', 0,
        { resolveMacros() { macroCalls++; return 'resolved'; } }, apply);
      assert.equal(message.content, 'Moonstone');
      assert.equal(bridge.messages([message])[0].content, 'Moonstone');
      assert.equal(macroCalls, 1);
      assert.equal(applyCalls, 2);
      assert.match(logs.join('\n'), /fail closed:/);
    });
  }
});
