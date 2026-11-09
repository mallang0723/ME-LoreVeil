'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { maskScanExclusions } = require('./scan-exclusion.cjs');

const CHAT_ROLES = new Set(['user', 'assistant', 'narrator']);
// Match the generation route's post-regex blank-line normalization.
const normalize = text => text.replace(/\n([ \t]*\n){2,}/g, '\n\n');
const MAX_ENTRIES = 4096;
const MAX_CHARS = 8 * 1024 * 1024;
const IDENTITY = Symbol('unchanged scan');

function createScanBridge(log = () => {}) {
  const scope = new AsyncLocalStorage();
  const requests = new WeakMap();
  const attached = new WeakSet();
  const reported = new Set();
  const fail = (reason, site = 'prompt-regex-scan-view') => {
    const key = site + ':' + reason;
    if (reported.has(key)) return;
    reported.add(key);
    try { log(`fail closed: ${site} (${reason})`); } catch {}
  };
  function close(request) {
    const state = requests.get(request);
    if (!state) return;
    state.closed = true;
    state.views.clear();
    state.objects = new WeakMap();
    requests.delete(request);
  }
  function attachRequestScope(app) {
    if (attached.has(app)) return;
    try {
      // preValidation runs after body parsing has rebound the async context.
      // Use request identity, never a user-supplied request-id or a global text map.
      app.addHook('preValidation', (request, _reply, done) => {
        const state = { views: new Map(), objects: new WeakMap(), chars: 0, closed: false };
        requests.set(request, state);
        scope.run(state, done);
      });
      app.addHook('onResponse', (request, _reply, done) => { close(request); done(); });
      app.addHook('onRequestAbort', (request, done) => { close(request); done(); });
      attached.add(app);
    } catch { fail('request hooks unavailable', 'request-scan-scope'); }
  }
  const keyFor = (role, text) => role + '\0' + normalize(text);
  function remember(state, message, output, scan) {
    if (state.closed) return;
    const key = keyFor(message.role, output);
    const normalizedScan = normalize(scan);
    const value = normalizedScan === normalize(output) ? IDENTITY : normalizedScan;
    if (state.views.has(key)) {
      if (state.views.get(key) !== value) {
        // Identity observations also participate: a visible message must never
        // inherit another message's exclusion merely because regex output matches.
        state.views.set(key, null);
        fail('ambiguous regex output; original scan retained');
      }
    } else {
      state.chars += key.length + normalizedScan.length;
      if (state.views.size >= MAX_ENTRIES || state.chars > MAX_CHARS) {
        state.closed = true;
        state.views.clear();
        state.objects = new WeakMap();
        fail('request scan-view limit reached');
        return;
      }
      state.views.set(key, value);
    }
    state.objects.set(message, { output, scan });
  }
  function regexText(message, scripts, placement, depth, options, apply) {
    const original = message.content;
    const state = scope.getStore();
    if (!state || state.closed || !CHAT_ROLES.has(message.role) || typeof original !== 'string') {
      return apply(original, scripts, placement, depth, options);
    }
    let scan;
    try {
      const previous = state.objects.get(message);
      scan = previous?.output === original ? previous.scan : maskScanExclusions(original);
    } catch {
      fail('scan preparation unavailable');
      return apply(original, scripts, placement, depth, options);
    }
    // Execute the real prompt path exactly once. Replay only values that its
    // macro resolver actually produced, so scan work cannot write macro variables,
    // advance a random source, or render the memory macro a second time.
    const resolutions = new Map();
    const resolve = options?.resolveMacros;
    const promptOptions = scan !== original && resolve ? {
      ...options,
      resolveMacros(value, seed) {
        const result = resolve.call(options, value, seed);
        const key = JSON.stringify([value, seed]);
        const queue = resolutions.get(key) ?? [];
        queue.push(result);
        resolutions.set(key, queue);
        return result;
      },
    } : options;
    const output = apply(original, scripts, placement, depth, promptOptions);
    try {
      if (scan === original) scan = output;
      else {
        let missed = false;
        const shadowOptions = resolve ? {
          ...options,
          resolveMacros(value, seed) {
            const queue = resolutions.get(JSON.stringify([value, seed]));
            if (!queue?.length) { missed = true; return value; }
            return queue.shift();
          },
        } : options;
        scan = apply(scan, scripts, placement, depth, shadowOptions);
        if (missed) {
          fail('scan macro replay unavailable; original scan retained');
          scan = output;
        }
      }
      remember(state, message, output, scan);
    } catch {
      fail('scan reconstruction unavailable');
      // Do not leave an older alias usable after reconstruction fails.
      try { remember(state, message, output, output); } catch {}
    }
    return output;
  }
  function messages(value) {
    if (!Array.isArray(value)) return value;
    const state = scope.getStore();
    let result = value;
    value.forEach((message, index) => {
      if (!message || !CHAT_ROLES.has(message.role)) return;
      let content = message.content;
      if (state && !state.closed && typeof content === 'string') {
        const scan = state.views.get(keyFor(message.role, content));
        if (typeof scan === 'string') content = scan;
      }
      content = maskScanExclusions(content);
      if (content === message.content) return;
      if (result === value) result = value.slice();
      result[index] = { ...message, content };
    });
    return result;
  }
  return { attachRequestScope, regexText, messages };
}

module.exports = { createScanBridge };
