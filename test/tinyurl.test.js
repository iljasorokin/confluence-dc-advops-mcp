import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTinyCode,
  decodeTinyCode,
  resolveTinyInput,
  swapDashUnderscore,
  decodeTinyCodeCandidates,
  parseContentIdFromLocation,
  resolveTinyUrlMeta,
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

test('decodeTinyCode: dash/underscore CR-772 — DC alphabet', () => {
  assert.equal(decodeTinyCode('-uN6Dw'), '259711998');
  assert.equal(decodeTinyCode('_uN6Dw'), '259711994');
  assert.equal(decodeTinyCode(swapDashUnderscore('_uN6Dw')), '259711998');
});

test('decodeTinyCodeCandidates: nf16Dw single candidate', () => {
  const c = decodeTinyCodeCandidates('nf16Dw');
  assert.equal(c.length, 1);
  assert.equal(c[0].contentId, '259718557');
  assert.equal(c[0].resolvedVia, 'decode');
});

test('decodeTinyCodeCandidates: -uN6Dw primary is live page id', () => {
  const c = decodeTinyCodeCandidates('-uN6Dw');
  assert.equal(c[0].contentId, '259711998');
  assert.equal(c[0].resolvedVia, 'decode');
  assert.deepEqual(
    c.map((x) => [x.resolvedVia, x.contentId]),
    [
      ['decode', '259711998'],
      ['decode-swapped', '259711994'],
    ],
  );
});

test('decodeTinyCodeCandidates: _uN6Dw swap recovers live id', () => {
  const c = decodeTinyCodeCandidates('_uN6Dw');
  assert.equal(c[0].contentId, '259711994');
  assert.ok(c.some((x) => x.resolvedVia === 'decode-swapped' && x.contentId === '259711998'));
});

test('parseContentIdFromLocation: pageId query', () => {
  assert.equal(
    parseContentIdFromLocation(
      'https://host/pages/viewpage.action?pageId=259711998',
    ),
    '259711998',
  );
});

test('resolveTinyUrlMeta: official decode hits live page without swap', async () => {
  const out = await resolveTinyUrlMeta('https://host/x/-uN6Dw', {
    getPageById: async (id) => {
      if (id === '259711998') {
        return {
          id: '259711998',
          title: 'CR-772-BRD',
          _links: { tinyui: '/x/-uN6Dw' },
        };
      }
      throw new Error(`GET /rest/api/content/${id} → 404: not found`);
    },
    followTinyUrl: async () => null,
  });
  assert.equal(out.resolvedVia, 'decode');
  assert.equal(out.contentId, '259711998');
  assert.equal(out.code, '-uN6Dw');
});

test('resolveTinyUrlMeta: RFC4648-looking _uN6Dw uses decode-swapped', async () => {
  const out = await resolveTinyUrlMeta('_uN6Dw', {
    getPageById: async (id) => {
      if (id === '259711998') {
        return { id: '259711998', title: 'CR-772-BRD', _links: { tinyui: '/x/-uN6Dw' } };
      }
      throw new Error(`GET /rest/api/content/${id} → 404: not found`);
    },
    followTinyUrl: async () => null,
  });
  assert.equal(out.resolvedVia, 'decode-swapped');
  assert.equal(out.contentId, '259711998');
});

test('resolveTinyUrlMeta: tinyurl-action fallback when both decodes 404', async () => {
  const calls = [];
  const out = await resolveTinyUrlMeta('-uN6Dw', {
    getPageById: async (id) => {
      calls.push(id);
      if (calls.length > 2 && id === '259711998') {
        return { id: '259711998', title: 'CR-772-BRD', _links: { tinyui: '/x/-uN6Dw' } };
      }
      throw new Error(`GET /rest/api/content/${id} → 404: not found`);
    },
    followTinyUrl: async (code) => {
      assert.equal(code, '-uN6Dw');
      return { contentId: '259711998' };
    },
  });
  assert.equal(out.resolvedVia, 'tinyurl-action');
  assert.deepEqual(calls, ['259711998', '259711994', '259711998']);
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
