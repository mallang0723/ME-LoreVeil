'use strict';
// In-memory load-hook structure inspired by tlsiddl's MIT memory runtime. See NOTICE.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');

const SUPPORTED_VERSIONS = ['2.5.1', '2.5.2'];
const KEY = 'ma-loreveil.runtime.v1';
const helper = `globalThis[Symbol.for(${JSON.stringify(KEY)})]`;
const PATCHES = [
  {
    name: 'request-scan-scope',
    file: 'lib/request-logging.js',
    anchor: 'export function registerRequestLogging(app, logController) {',
    insert: `\n    ${helper}.attachRequestScope(app);`,
  },
  {
    name: 'prompt-regex-scan-view',
    file: 'services/regex/regex-application.js',
    anchor: '        message.content = applyRegexScriptsToPromptText(message.content, scripts, placement, depth, {\n            ...options,\n            randomSeed,\n        });',
    replacement: `        message.content = ${helper}.regexText(message, scripts, placement, depth, {\n            ...options,\n            randomSeed,\n        }, applyRegexScriptsToPromptText);`,
  },
  {
    name: 'keyword-chat-and-pinned',
    file: 'services/lorebook/keyword-scanner.js',
    anchor: 'export function scanForActivatedEntries(messages, entries, options = {}) {',
    insert: `\n    messages = ${helper}.messages(messages);\n    options = ${helper}.options(options);`,
  },
  {
    name: 'semantic-lorebook-query',
    file: 'services/lorebook/embeddings.js',
    anchor: 'export function selectLorebookVectorQueryText(messages, depth) {',
    insert: `\n    messages = ${helper}.messages(messages);`,
  },
  {
    name: 'semantic-router-query',
    file: 'services/agents/knowledge-router.js',
    anchor: 'export function buildKnowledgeRouterQuery(context) {',
    insert: `\n    context = ${helper}.context(context);`,
  },
];

function patchSource(source, patch) {
  const replaced = patch.replacement && !source.includes(patch.anchor);
  const anchor = replaced ? patch.replacement : patch.anchor;
  if (source.split(anchor).length !== 2) return null;
  const offset = source.indexOf(anchor);
  if (offset > 0 && source[offset - 1] !== '\n') return null;
  if (!['\n', '\r'].includes(source[offset + anchor.length])) return null;
  if (replaced || source.includes(patch.anchor + patch.insert)) return source;
  return source.replace(patch.anchor, () => patch.replacement ?? patch.anchor + patch.insert);
}

function checkVersion(serverRoot) {
  try {
    const server = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
    const root = JSON.parse(fs.readFileSync(path.join(serverRoot, '../..', 'package.json'), 'utf8'));
    if (server.name !== '@marinara-engine/server' || root.name !== 'marinara-engine') return 'package identity mismatch';
    if (!SUPPORTED_VERSIONS.includes(root.version) || server.version !== root.version) return 'unsupported or inconsistent version';
    return null;
  } catch {
    return 'package metadata unavailable';
  }
}

function log(message) {
  try { process.stderr.write(`[loreveil] ${message}\n`); } catch { /* logging must not break the host */ }
}

function install() {
  if (process.env.LOREVEIL_DISABLED === '1') return;
  if (globalThis[Symbol.for(KEY)]) return;
  if (typeof registerHooks !== 'function') {
    for (const patch of PATCHES) log(`fail closed: ${patch.name} (Node module.registerHooks unavailable)`);
    return;
  }
  const bridge = require('../lib/regex-scan-view.cjs').createScanBridge(log);
  const messages = (value) => {
    try { return bridge.messages(value); } catch { return value; }
  };
  const api = Object.freeze({
    attachRequestScope: bridge.attachRequestScope,
    regexText: bridge.regexText,
    messages,
    options(value) {
      try {
        const pinnedScanMessages = messages(value.pinnedScanMessages);
        return pinnedScanMessages === value.pinnedScanMessages ? value : { ...value, pinnedScanMessages };
      } catch { return value; }
    },
    context(value) {
      try {
        const recentMessages = messages(value.recentMessages);
        return recentMessages === value.recentMessages ? value : { ...value, recentMessages };
      } catch { return value; }
    },
  });
  const reported = new Set();
  const versions = new Map();
  const report = (filename, patch, reason) => {
    if (reported.has(filename)) return;
    reported.add(filename);
    log(reason ? `fail closed: ${patch.name} (${reason})` : `applied: ${patch.name}`);
  };
  // Publish the helper only after hook registration succeeds. Hooks run on subsequent loads.
  registerHooks({
    load(url, context, nextLoad) {
      let filename;
      try { filename = fileURLToPath(url); } catch { return nextLoad(url, context); }
      const normalized = filename.split(path.sep).join('/');
      const patch = PATCHES.find((p) => normalized.endsWith('/packages/server/dist/' + p.file));
      if (!patch) return nextLoad(url, context);
      // Preserve loader chaining and propagate the engine's own load errors normally.
      const result = nextLoad(url, context);
      try {
        const serverRoot = path.resolve(filename, ...Array(patch.file.split('/').length + 1).fill('..'));
        if (!versions.has(serverRoot)) versions.set(serverRoot, checkVersion(serverRoot));
        const reason = versions.get(serverRoot);
        if (reason) { report(filename, patch, reason); return result; }
        if (result.format !== 'module') { report(filename, patch, 'unexpected module format'); return result; }
        const source = result.source == null ? fs.readFileSync(filename, 'utf8')
          : typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
        const output = patchSource(source, patch);
        if (output === null) { report(filename, patch, 'expected exactly one source anchor'); return result; }
        report(filename, patch, null);
        return output === source ? result : { ...result, source: output };
      } catch {
        report(filename, patch, 'patch unavailable');
        return result;
      }
    },
  });
  globalThis[Symbol.for(KEY)] = api;
}

try { install(); } catch {
  for (const patch of PATCHES) log(`fail closed: ${patch.name} (runtime installation unavailable)`);
}

module.exports = { PATCHES, patchSource, checkVersion, SUPPORTED_VERSIONS };
