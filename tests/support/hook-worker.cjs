'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { reference, entry, cleanHTML } = require('./reference.cjs');
const { requestHarness } = require('./request-scope.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');

(async () => {
  const root = process.argv[2];
  const logScope = new AsyncLocalStorage();
  globalThis.__loreveilTestBindings = { ...reference().bindings,
    randomUUID: require('node:crypto').randomUUID, LogController: class {},
    runWithRootLogContext: (context, fn) => logScope.run(context, fn),
  };
  const load = file => import(pathToFileURL(path.join(root, 'packages/server/dist', file)));
  const scanner = await load('services/lorebook/keyword-scanner.js');
  const embeddings = await load('services/lorebook/embeddings.js');
  const router = await load('services/agents/knowledge-router.js');
  const regex = await load('services/regex/regex-application.js');
  const { registerRequestLogging } = await load('lib/request-logging.js');
  const requests = requestHarness(app => registerRequestLogging(app, { clientAborted() {} }));
  // A second URL exercises duplicate-log suppression for the same file.
  await import(pathToFileURL(path.join(root, 'packages/server/dist/services/lorebook/keyword-scanner.js')) + '?again');
  await import(pathToFileURL(path.join(root, 'packages/shared/dist/utils/macro-engine.js')));
  const content = '<div loreveil><ad-stat>Moonstone</ad-stat></div>';
  const messages = Object.freeze([Object.freeze({ role: 'user', content })]);
  const clean = await requests.run(async () => {
    const input = [{ role: 'user', content }];
    regex.applyRegexScriptsToPromptMessages(input, [cleanHTML]);
    await Promise.resolve();
    return {
      cleanActivated: scanner.scanForActivatedEntries(input, [entry()]).length,
      cleanSemantic: embeddings.selectLorebookVectorQueryText(input, 2),
      cleanRouter: router.buildKnowledgeRouterQuery({ recentMessages: input }),
      cleanPrompt: input[0].content,
    };
  });
  process.stdout.write(JSON.stringify({
    ...clean,
    activated: scanner.scanForActivatedEntries(messages, [entry()]).length,
    semantic: embeddings.selectLorebookVectorQueryText(messages, 2),
    router: router.buildKnowledgeRouterQuery({ recentMessages: messages }),
    unchanged: messages[0].content === content,
    systemActivated: scanner.scanForActivatedEntries([{ role: 'system', content }], [entry()]).length,
    memory: Boolean(globalThis.__marinaraMemory),
  }) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
