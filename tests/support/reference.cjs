'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../fixtures/marinara');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

// Execute the real compiled functions with explicit dependencies. No scanner or
// matching logic is mocked. Embedding I/O is injected to capture query text.
function evaluate(source, dependencies, names) {
  const body = source.replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${body}\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies));
}
const logger = Object.freeze({ debug() {}, warn() {}, info() {} });
function reference(version = '2.5.2', transform = s => s, embed = async () => []) {
  const { isPatternSafe } = evaluate(read(`${version}-regex-safety.js`), {}, ['isPatternSafe']);
  const matching = evaluate(read('lorebook-keyword-matching.js'), { isPatternSafe }, ['testPrimaryKeys', 'testSecondaryKeys']);
  const { createSeededRandom } = evaluate(read('seeded-random.js'), {}, ['createSeededRandom']);
  const { vmRegexExecutor, vmRegexReplaceGuard } = evaluate(read('regex-timeout.js'), { logger, vm }, ['vmRegexExecutor', 'vmRegexReplaceGuard']);
  const regexReplacement = evaluate(read('regex-replacement.js'), {}, ['applyRegexReplacement', 'resolveRegexPatternLiteralMacros']);
  const regexBindings = { logger, isPatternSafe, vmRegexReplaceGuard, ...regexReplacement };
  const regex = evaluate(transform(read('regex-application.js'), 'regex-application.js'), regexBindings,
    ['applyRegexScriptsToPromptMessages', 'applyRegexScriptsToPromptText']);
  const LIMITS = { LOREBOOK_VECTOR_MAX_RESULTS_DEFAULT: 10, LOREBOOK_VECTOR_QUERY_DEPTH_DEFAULT: 10, LOREBOOK_VECTOR_QUERY_DEPTH_MAX: 100 };
  const embeddings = evaluate(transform(read('embeddings.js'), 'embeddings.js'), {
    LIMITS, logger, embedMemoryRecallTexts: embed,
    localEmbed: () => { throw new Error('Real models forbidden in tests'); },
    createLorebooksStorage: () => { throw new Error('Storage not part of unit tests'); },
  }, ['selectLorebookVectorQueryText', 'buildLorebookSemanticEmbeddingsById', 'buildLorebookEntryEmbeddingText', 'calibrateLorebookSimilarity']);
  const scanner = evaluate(transform(read('keyword-scanner.js'), 'keyword-scanner.js'), {
    LIMITS, logger, ...matching, vmRegexExecutor, createSeededRandom,
    calibrateLorebookSimilarity: embeddings.calibrateLorebookSimilarity,
  }, ['scanForActivatedEntries', 'recursiveScan']);
  const router = evaluate(transform(read('knowledge-router.js'), 'knowledge-router.js'), {
    logger, scanForActivatedEntries: scanner.scanForActivatedEntries,
  }, ['buildKnowledgeRouterQuery']);
  return { ...scanner, ...embeddings, ...router, ...regex, bindings: { ...regexBindings, LIMITS, logger, ...matching, vmRegexExecutor, createSeededRandom, calibrateLorebookSimilarity: embeddings.calibrateLorebookSimilarity } };
}
function entry(overrides = {}) {
  return {
    id: 'keyword', lorebookId: 'book', name: 'Test', content: 'LOREVEIL_ENTRY_SENTINEL',
    enabled: true, keys: ['Moonstone'], secondaryKeys: [], selective: false,
    selectiveLogic: 'and', constant: false, order: 100, scanDepth: null,
    activationConditions: [], schedule: null, sticky: null, cooldown: null, delay: null,
    probability: 100, caseSensitive: false, useRegex: false, matchWholeWords: false,
    preventRecursion: false, excludeRecursion: false, delayUntilRecursion: false,
    ...overrides,
  };
}
const { CLEAN_HTML_FIND_REGEX } = evaluate(read('seed-regex.js'), {}, ['CLEAN_HTML_FIND_REGEX']);
const cleanHTML = { enabled: true, findRegex: CLEAN_HTML_FIND_REGEX, flags: 'g', replaceString: '',
  promptOnly: true, placement: ['user_input', 'ai_output'] };
module.exports = { reference, entry, read, evaluate, cleanHTML };
