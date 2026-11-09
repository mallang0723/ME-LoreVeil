'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read } = require('./reference.cjs');
const runtime = path.resolve(__dirname, '../../runtime/ma-loreveil-runtime.cjs');

function runHook({ version = '2.5.2', disabled = false, broken = false, duplicate = false, brokenSite, memory, order = 'first' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loreveil-hooks-'));
  const originals = new Map();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
    originals.set(file, text);
  };
  try {
    write('package.json', JSON.stringify({ name: 'marinara-engine', version, type: 'module' }));
    write('packages/server/package.json', JSON.stringify({ name: '@marinara-engine/server', version, type: 'module' }));
    const { PATCHES } = require('../../runtime/ma-loreveil-runtime.cjs');
    for (const { file, anchor, name } of PATCHES) {
      let source = read(path.basename(file)).replace(/^import[\s\S]*?;\n/gm, '');
      if (brokenSite === name) source = source.replace(anchor, anchor.replace(/\(/, '( '));
      if (file.endsWith('keyword-scanner.js') && broken) source = source.replace('scanForActivatedEntries(messages, entries, options = {}) {', 'scanForActivatedEntries(messages, entries, options={}) {');
      if (file.endsWith('keyword-scanner.js') && duplicate) source += '\n// export function scanForActivatedEntries(messages, entries, options = {}) {\n';
      const names = file.endsWith('request-logging.js') ? 'randomUUID, LogController, runWithRootLogContext'
        : file.endsWith('regex-application.js') ? 'logger, isPatternSafe, vmRegexReplaceGuard, applyRegexReplacement, resolveRegexPatternLiteralMacros'
        : file.endsWith('keyword-scanner.js')
        ? 'LIMITS, logger, testPrimaryKeys, testSecondaryKeys, vmRegexExecutor, createSeededRandom, calibrateLorebookSimilarity'
        : 'LIMITS, logger';
      write('packages/server/dist/' + file, `const { ${names} } = globalThis.__loreveilTestBindings;\n` + source);
    }
    // Memory's real loader must successfully patch its own independent target.
    write('packages/shared/dist/utils/macro-engine.js', 'export function macro(result, ctx) {\n    result = result.replace(/\\{\\{chatId\\}\\}/gi, ctx.chatId ?? "");\nreturn result;\n}\n');
    const requires = memory ? (order === 'first' ? [runtime, memory] : [memory, runtime]) : [runtime];
    // Regular files also work in sandboxes that disallow libuv's socket-backed stdio pipes.
    const stdoutFile = path.join(root, 'stdout.txt');
    const stderrFile = path.join(root, 'stderr.txt');
    const out = fs.openSync(stdoutFile, 'w');
    const err = fs.openSync(stderrFile, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [...requires.flatMap(file => ['--require', file]), path.join(__dirname, 'hook-worker.cjs'), root], {
        stdio: ['ignore', out, err], timeout: 15000,
        env: { LOREVEIL_DISABLED: disabled ? '1' : '0', MEMORY_MODULE_ANY_PROCESS: '1', MEMORY_MODULE_NOTES_DIR: path.join(root, 'notes') },
      });
    } finally { fs.closeSync(out); fs.closeSync(err); }
    result.stdout = fs.readFileSync(stdoutFile, 'utf8');
    result.stderr = fs.readFileSync(stderrFile, 'utf8');
    if (result.error) result.stderr += '\n' + result.error.message;
    for (const [file, content] of originals) {
      if (fs.readFileSync(path.join(root, file), 'utf8') !== content) throw new Error(`Runtime modified ${file} on disk`);
    }
    return { ...result, data: result.status === 0 ? JSON.parse(result.stdout.trim()) : null };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { runHook };
