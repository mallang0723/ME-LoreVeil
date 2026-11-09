'use strict';
// Port of st-loreveil's author-owned parser; fixed MVP names. See NOTICE.
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || /\s/.test(c);
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isNameChar = (c) => isAlpha(c) || (c >= '0' && c <= '9') || c === '_' || c === ':' || c === '-';

/**
 * Parse a tag starting at text[start] === '<'. Returns null when no tag name follows,
 * otherwise { closing, name (lowercase), end (index after '>', or -1 if unterminated),
 * selfClosing, attrs: string[] (lowercased names) }.
 */
function parseTag(text, start, wantAttrs) {
  const n = text.length;
  let p = start + 1;
  const closing = text[p] === '/';
  if (closing) p++;
  if (p >= n || !isAlpha(text[p])) return null;
  const nameStart = p;
  while (p < n && isNameChar(text[p])) p++;
  const name = text.slice(nameStart, p).toLowerCase();
  const attrs = [];
  let slash = false;
  for (;;) {
    while (p < n && isWs(text[p])) p++;
    if (p >= n) return { closing, name, end: -1, selfClosing: false, attrs };
    const c = text[p];
    if (c === '>') return { closing, name, end: p + 1, selfClosing: slash, attrs };
    if (c === '/') { slash = true; p++; continue; }
    if (c === '=') { slash = false; p++; continue; }
    const s = p;
    while (p < n) {
      const d = text[p];
      if (d === '>' || d === '/' || d === '=' || isWs(d)) break;
      p++;
    }
    slash = false;
    if (wantAttrs) attrs.push(text.slice(s, p).toLowerCase());
    while (p < n && isWs(text[p])) p++;
    if (text[p] === '=') {
      p++;
      while (p < n && isWs(text[p])) p++;
      const q = text[p];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, p + 1);
        if (close === -1) return { closing, name, end: -1, selfClosing: false, attrs };
        p = close + 1;
      } else {
        while (p < n && text[p] !== '>' && !isWs(text[p])) p++;
      }
    }
  }
}

/** Replace the given sorted, non-overlapping [start, end) ranges with spaces. */
function blank(text, ranges) {
  let out = '';
  let last = 0;
  for (const [s, e] of ranges) {
    out += text.slice(last, s) + ' '.repeat(e - s);
    last = e;
  }
  return out + text.slice(last);
}

/** Find the index of the next "</name" (case-insensitive, followed by ws, '/' or '>'), or -1. */
function findRawTextEnd(text, from, name) {
  const n = text.length;
  let k = text.indexOf('</', from);
  while (k !== -1) {
    const after = k + 2 + name.length;
    if (after <= n && text.slice(k + 2, after).toLowerCase() === name) {
      const c = text[after];
      if (after === n ? false : (c === '>' || c === '/' || isWs(c))) return k;
    }
    k = text.indexOf('</', k + 2);
  }
  return -1;
}

function markerRanges(text, markers) {
  const ranges = [];
  const n = text.length;
  let depth = 0;
  let regionStart = 0;
  let i = text.indexOf('!--');
  while (i !== -1) {
    let hit = null;
    for (const m of markers) {
      if (text.startsWith(m.str, i)) { hit = m; break; }
    }
    if (hit) {
      const next = i + hit.str.length;
      if (hit.start) {
        if (depth === 0) regionStart = i;
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0) ranges.push([regionStart, next]);
      }
      i = text.indexOf('!--', next);
    } else {
      i = text.indexOf('!--', i + 1);
    }
  }
  if (depth > 0) ranges.push([regionStart, n]);
  return ranges;
}

function elementRanges(text, tagSet, useAttrs) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const j = text.indexOf('<', i);
    if (j === -1) break;
    if (text.startsWith('<!--', j)) {
      const k = text.indexOf('-->', j + 4);
      if (k === -1) break;
      i = k + 3;
      continue;
    }
    const tag = parseTag(text, j, useAttrs);
    if (!tag) { i = j + 1; continue; }
    if (tag.end === -1) {
      if (!tag.closing && isExcluded(tag, tagSet, useAttrs)) ranges.push([j, n]);
      break;
    }
    if (tag.closing) { i = tag.end; continue; }
    if (isExcluded(tag, tagSet, useAttrs)) {
      if (tag.selfClosing || VOID_ELEMENTS.has(tag.name)) {
        ranges.push([j, tag.end]);
        i = tag.end;
        continue;
      }
      // Open a region; only same-name tags matter inside.
      let depth = 0;
      let p = tag.end;
      let regionEnd = n;
      let done = false;
      while (!done) {
        const q = text.indexOf('<', p);
        if (q === -1) break;
        if (text.startsWith('<!--', q)) {
          const k = text.indexOf('-->', q + 4);
          if (k === -1) break;
          p = k + 3;
          continue;
        }
        // Only same-name tags matter inside a region: anything else is plain text.
        const closing = text[q + 1] === '/';
        const nameAt = q + (closing ? 2 : 1);
        const after = nameAt + tag.name.length;
        if (text.slice(nameAt, after).toLowerCase() !== tag.name || (after < n && isNameChar(text[after]))) {
          p = q + 1;
          continue;
        }
        const t = parseTag(text, q, false);
        if (!t) { p = q + 1; continue; }
        if (t.end === -1) break;
        if (t.closing) {
          if (depth === 0) { regionEnd = t.end; done = true; }
          else depth--;
        } else if (!t.selfClosing) {
          depth++;
        }
        p = t.end;
      }
      ranges.push([j, regionEnd]);
      i = regionEnd;
      continue;
    }
    if (!tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const k = findRawTextEnd(text, tag.end, tag.name);
      if (k === -1) break;
      i = k;
      continue;
    }
    i = tag.end;
  }
  return ranges;
}

function isExcluded(tag, tagSet, useAttrs) {
  if (tagSet.has(tag.name)) return true;
  if (useAttrs) {
    for (const a of tag.attrs) if (tagSet.has(a)) return true;
  }
  return false;
}

const tagSet = new Set(['wi-exclude']);
const markers = [
  { str: '!--WI_EXCLUDE_START--!', start: true },
  { str: '!--WI_EXCLUDE_END--!', start: false },
];

function maskScanExclusions(text) {
  if (typeof text !== 'string' || !/wi[-_]exclude/i.test(text)) return text;
  let cur = text;
  const mr = markerRanges(cur, markers);
  if (mr.length) cur = blank(cur, mr);
  const er = elementRanges(cur, tagSet, true);
  if (er.length) cur = blank(cur, er);
  if (!mr.length && !er.length) return text;
  return cur.trim() === '' ? '' : cur;
}

// Copy only changed chat messages; system/tool/source material is never masked.
function maskChatMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let output = messages;
  messages.forEach((message, index) => {
    if (!message || !['user', 'assistant', 'narrator'].includes(message.role)) return;
    const content = maskScanExclusions(message.content);
    if (content === message.content) return;
    if (output === messages) output = messages.slice();
    output[index] = { ...message, content };
  });
  return output;
}

module.exports = { maskScanExclusions, maskChatMessages };
