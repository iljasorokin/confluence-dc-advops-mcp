import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTinyCode,
  decodeTinyCode,
  resolveTinyInput,
} from '../tinyurl.js';

test('extractTinyCode: full https URL', () => {
  assert.equal(
    extractTinyCode('https://cnfl.example.com/x/nf16Dw'),
    'nf16Dw',
  );
});

test('extractTinyCode: path and bare code', () => {
  assert.equal(extractTinyCode('/x/nf16Dw'), 'nf16Dw');
  assert.equal(extractTinyCode('nf16Dw'), 'nf16Dw');
});

test('extractTinyCode: tinyurl.action query', () => {
  assert.equal(
    extractTinyCode(
      'https://cnfl.example.com/pages/tinyurl.action?urlIdentifier=nf16Dw',
    ),
    'nf16Dw',
  );
});

test('decodeTinyCode: known mapping nf16Dw → 259718557', () => {
  assert.equal(decodeTinyCode('nf16Dw'), '259718557');
});

test('resolveTinyInput: end-to-end', () => {
  assert.deepEqual(resolveTinyInput('https://host/x/nf16Dw'), {
    code: 'nf16Dw',
    contentId: '259718557',
  });
});

test('extractTinyCode: rejects garbage', () => {
  assert.throws(() => extractTinyCode('https://example.com/wiki/foo'), /Cannot parse/);
  assert.throws(() => extractTinyCode(''), /empty/);
});
