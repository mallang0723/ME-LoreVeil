'use strict';
// Explicit opt-in command; requires complete temp Marinara builds and local TCP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');

const hidden = '<div wi-exclude><ad-stat>Moonstone</ad-stat></div>';
const sentinel = 'LOREVEIL_ENTRY_SENTINEL_73C9';
const recSentinel1 = 'LOREVEIL_REC_ROOT_5A21';
const recSentinel2 = 'LOREVEIL_REC_CHILD_9F04';
const runtime = path.resolve(__dirname, '../../runtime/ma-loreveil-runtime.cjs');

function tempReference(value, name) {
  assert.ok(value && path.isAbsolute(value), `${name} must be an absolute /tmp reference path`);
  const resolved = fs.realpathSync(value);
  assert.ok(resolved.startsWith('/tmp/'), `${name}: refuse to operate on a non-temporary installation`);
  return resolved;
}

async function fakeModel(t, captures) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'loreveil-fake', object: 'model' }] }));
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404); return res.end();
    }
    try {
      let text = '';
      for await (const part of req) text += part;
      const body = JSON.parse(text);
      captures.push(body);
      const content = 'A quiet test reply.';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
          res.write('data: ' + JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: 'loreveil-fake', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'loreveil-fake',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  assert.ok(port > 10000);
  return `http://127.0.0.1:${port}/v1`;
}

async function startEngine(t, engine, memory, order, directory) {
  const addressFile = path.join(directory, 'address.json');
  const bootstrap = path.join(directory, 'boot.mjs');
  const logFile = path.join(directory, 'server.log');
  const appUrl = pathToFileURL(path.join(engine, 'packages/server/dist/app.js')).href;
  fs.writeFileSync(bootstrap, `
import { writeFileSync } from 'node:fs';
import { buildApp } from ${JSON.stringify(appUrl)};
const app = await buildApp();
process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
await app.listen({ port: 0, host: '127.0.0.1' });
writeFileSync(${JSON.stringify(addressFile)}, JSON.stringify(app.server.address()));
`);
  const requires = order === 'first' ? [runtime, memory] : order === 'none' ? [memory] : [memory, runtime];
  const log = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [...requires.flatMap(file => ['--require', file]), bootstrap], {
    cwd: engine, stdio: ['ignore', log, log],
    env: {
      NODE_ENV: 'test', DATA_DIR: path.join(directory, 'data'),
      FILE_STORAGE_DIR: path.join(directory, 'data/storage'),
      MARINARA_ENV_FILE: path.join(directory, '.env'),
      HOST: '127.0.0.1', PORT: '17859', LOG_LEVEL: 'warn', LOG_FORMAT: 'json',
      AUTO_CREATE_DEFAULT_CONNECTION: 'false', PROVIDER_LOCAL_URLS_ENABLED: 'true',
      UPDATES_APPLY_DISABLED: 'true', MARINARA_NOTICES_ENABLED: 'false',
      ...(process.env.LOREVEIL_DISABLED ? { LOREVEIL_DISABLED: process.env.LOREVEIL_DISABLED } : {}),
      MEMORY_MODULE_ANY_PROCESS: '1', MEMORY_MODULE_NOTES_DIR: path.join(directory, 'notes'),
    },
  });
  fs.closeSync(log);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  for (let i = 0; i < 300; i++) {
    if (spawnError) throw spawnError;
    if (fs.existsSync(addressFile)) {
      const address = JSON.parse(fs.readFileSync(addressFile, 'utf8'));
      assert.ok(address.port > 10000);
      return `http://127.0.0.1:${address.port}`;
    }
    if (child.exitCode !== null) throw new Error(`Temporary server exited ${child.exitCode}; see ${logFile}`);
    await delay(100);
  }
  throw new Error(`Temporary server startup timed out; see ${logFile}`);
}

for (const order of (process.env.LOREVEIL_ORDERS || 'first,last').split(',')) test(`full HTTP E2E: LoreVeil ${order}, memory runtime enabled`, { timeout: 180000 }, async t => {
  const engine = tempReference(process.env.LOREVEIL_ENGINE_ROOT, 'LOREVEIL_ENGINE_ROOT');
  const memory = tempReference(process.env.LOREVEIL_MEMORY_RUNTIME, 'LOREVEIL_MEMORY_RUNTIME');
  const version = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'))).version;
  assert.ok(['2.5.1', '2.5.2'].includes(version));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loreveil-e2e-'));
  t.diagnostic(`Evidence directory: ${directory}; engine ${version}; order ${order}`);
  const captures = [];
  const modelUrl = await fakeModel(t, captures);
  const base = await startEngine(t, engine, memory, order, directory);
  async function request(route, body, raw = false, method) {
    const response = await fetch(base + route, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${route}: ${response.status} ${text.slice(0, 1000)}`);
    return raw ? text : JSON.parse(text);
  }
  const connection = await request('/api/connections', {
    name: 'LoreVeil fake only', provider: 'custom', baseUrl: modelUrl,
    model: 'loreveil-fake', apiKey: '', isDefault: true,
  });
  // Marinara seeds a default "Clean HTML (Outgoing Prompt)" regex script that strips tags from the
  // outgoing prompt. The scan bridge must retain exclusion with this default ON.
  // LOREVEIL_CLEAN_HTML=off keeps the markup in the model's prompt for the legacy variant.
  const cleanOff = process.env.LOREVEIL_CLEAN_HTML === 'off';
  if (cleanOff) await request('/api/regex-scripts/default-clean-html', { enabled: false }, false, 'PATCH');
  const exclusionActive = order !== 'none' && process.env.LOREVEIL_DISABLED !== '1';
  const book = await request('/api/lorebooks', { name: 'LoreVeil test', isGlobal: true, recursiveScanning: true, excludeFromVectorization: true });
  await request(`/api/lorebooks/${book.id}/entries`, { name: 'Moonstone', keys: ['Moonstone'], content: sentinel, probability: 100 });
  await request(`/api/lorebooks/${book.id}/entries`, { name: 'Sunbeam', keys: ['Sunbeam'], content: recSentinel1 + ' It speaks of Starfall.', preventRecursion: false, probability: 100 });
  await request(`/api/lorebooks/${book.id}/entries`, { name: 'Starfall', keys: ['Starfall'], content: recSentinel2, probability: 100 });
  t.diagnostic('book recursiveScanning=' + book.recursiveScanning + ' enabled=' + book.enabled);
  const evidence = [];
  const cases = [
    { label: 'hidden-only', outside: false, recursion: false },
    { label: 'hidden+outside', outside: true, recursion: false },
    { label: 'hidden+recursion-seed', outside: false, recursion: true },
  ];
  for (const c of cases) {
    const content = 'Continue the scene. ' + hidden + (c.outside ? ' Moonstone is visible.' : '') + (c.recursion ? ' A Sunbeam falls.' : '');
    const chat = await request('/api/chats', { name: `LoreVeil ${c.label}`, mode: 'roleplay', connectionId: connection.id });
    const before = captures.length;
    const generation = await request('/api/generate', { chatId: chat.id, connectionId: connection.id, userMessage: content, streaming: false }, true);
    fs.writeFileSync(path.join(directory, 'model-requests.partial.json'), JSON.stringify(captures, null, 2));
    const sent = captures.slice(before).find(body => JSON.stringify(body.messages).includes('Continue the scene.'));
    assert.ok(sent, `No fake-model request for case ${c.label}: ${generation.slice(0, 600)}`);
    const prompt = JSON.stringify(sent.messages);
    const row = { case: c.label, cleanHtml: cleanOff ? 'off' : 'default', exclusionActive,
      moonstoneActivated: prompt.includes(sentinel), recursionRoot: prompt.includes(recSentinel1), recursionChild: prompt.includes(recSentinel2),
      statusBlockInPrompt: prompt.includes(hidden) };
    assert.equal(row.statusBlockInPrompt, cleanOff, `${c.label}: prompt keeps Marinara's configured regex output`);
    const expectedPromptContent = cleanOff ? content : content.replace(/<[^>]*>/g, '');
    assert.ok(sent.messages.some(message => typeof message.content === 'string' && message.content.includes(expectedPromptContent)),
      `${c.label}: full regex output, including hidden Moonstone, must reach the model`);
    assert.equal(row.moonstoneActivated, c.outside || !exclusionActive, `${c.label}: Moonstone activation`);
    if (c.recursion) assert.ok(row.recursionRoot && row.recursionChild, `${c.label}: recursive scan must still run`);
    const stored = await request(`/api/chats/${chat.id}/messages`);
    assert.ok(JSON.stringify(stored).includes(JSON.stringify(content).slice(1, -1)), 'stored message content must be unchanged');
    row.storedMessagePreserved = true;
    evidence.push(row);
  }
  const serverLog = fs.readFileSync(path.join(directory, 'server.log'), 'utf8');
  const sites = ['request-scan-scope', 'prompt-regex-scan-view', 'keyword-chat-and-pinned', 'semantic-lorebook-query', 'semantic-router-query'];
  if (exclusionActive) {
    for (const site of sites) assert.ok(serverLog.includes(`[loreveil] applied: ${site}`), `missing applied log: ${site}`);
    assert.equal(serverLog.includes('[loreveil] fail closed:'), false, 'all E2E sites must apply');
  } else assert.equal(serverLog.includes('[loreveil] applied:'), false);
  console.log('E2E-EVIDENCE ' + JSON.stringify({ version, order, evidence }));
  fs.writeFileSync(path.join(directory, 'model-requests.json'), JSON.stringify(captures, null, 2));
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ version, order, evidence }, null, 2));
});
