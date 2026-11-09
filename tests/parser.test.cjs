'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maskScanExclusions: mask, maskChatMessages } = require('../lib/scan-exclusion.cjs');
const vectors = require('./fixtures/parser-vectors.json');

for (const vector of vectors) test(`parser: ${vector.name}`, () => {
  let expected = vector.input;
  for (const region of vector.blank ?? []) expected = expected.replace(region, ' '.repeat(region.length));
  if (vector.expectEmpty) expected = '';
  assert.equal(mask(vector.input), expected);
});

test('fast path preserves strings, objects, arrays and unchanged message identity', () => {
  for (const value of ['ordinary words', '', '   ', null, undefined, {}, new String('plain')]) {
    assert.equal(mask(value), value);
  }
  const plain = Object.freeze({ role: 'user', content: 'ordinary words' });
  const messages = Object.freeze([plain]);
  assert.equal(maskChatMessages(messages), messages);
  assert.equal(maskChatMessages(messages)[0], plain);
});

test('retired markers are ordinary text and preserve message identity', () => {
  for (const content of [
    '<wi-exclude>Moonstone</wi-exclude>',
    '!--WI_EXCLUDE_START--!Moonstone!--WI_EXCLUDE_END--!',
    '<div wi-exclude>Moonstone</div>',
  ]) {
    assert.equal(mask(content), content);
    // Also exercise parsing after the new fast-path check has matched.
    assert.equal(mask('loreveil ' + content), 'loreveil ' + content);
    const message = Object.freeze({ role: 'user', content });
    const messages = Object.freeze([message]);
    assert.equal(maskChatMessages(messages), messages);
    assert.equal(maskChatMessages(messages)[0], message);
  }
});

test('only changed chat objects are copied; system/tool and metadata remain intact', () => {
  const hidden = '<div loreveil><ad-stat>Moonstone</ad-stat></div>';
  const messages = Object.freeze(['user', 'assistant', 'narrator', 'system', 'tool'].map(role =>
    Object.freeze({ role, content: hidden, id: role, metadata: Object.freeze({ original: true }) })));
  const result = maskChatMessages(messages);
  assert.notEqual(result, messages);
  for (let i = 0; i < 3; i++) {
    assert.equal(result[i].content, '');
    assert.equal(result[i].metadata, messages[i].metadata);
    assert.equal(messages[i].content, hidden);
  }
  assert.equal(result[3], messages[3]);
  assert.equal(result[4], messages[4]);
});

test('nested excluded elements and marker-first processing retain visible suffixes', () => {
  assert.equal(mask('<loreveil>a<loreveil>b</loreveil>c</loreveil>ok').trim(), 'ok');
  assert.equal(mask('!--LOREVEIL_START--!<div loreveil>!--LOREVEIL_END--!Moonstone').trim(), 'Moonstone');
  assert.equal(mask('<div data-loreveil>Moonstone</div>'), '<div data-loreveil>Moonstone</div>');
});
