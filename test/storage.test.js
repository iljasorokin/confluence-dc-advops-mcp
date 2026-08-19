import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listHeadings,
  getSection,
  replaceSection,
  listMacros,
  replaceMacroBody,
} from '../storage.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'page.xml');

function workCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'storage-'));
  const dest = join(dir, 'page.xml');
  copyFileSync(FIXTURE, dest);
  return dest;
}

test('listHeadings: order and marker stripped from heading text', () => {
  const { headings } = listHeadings(FIXTURE);
  assert.equal(headings.length, 4);
  assert.deepEqual(
    headings.map((h) => ({ index: h.index, level: h.level, text: h.text })),
    [
      { index: 0, level: 2, text: 'Матрица оценки' },
      { index: 1, level: 3, text: 'Вложенный критерий' },
      { index: 2, level: 2, text: 'Предметная область' },
      { index: 3, level: 2, text: 'Матрица оценки' },
    ],
  );
});

test('getSection: h2 stops at next h2, includes inner h3', () => {
  const sec = getSection(FIXTURE, {
    headingIndex: 0,
    heading: 'Матрица оценки',
    format: 'text',
  });
  assert.equal(sec.level, 2);
  assert.match(sec.body, /Вложенный критерий/);
  assert.match(sec.body, /Nested body/);
  assert.doesNotMatch(sec.body, /Предметная область/);
  assert.equal(sec.truncated, false);
  assert.doesNotMatch(sec.body, /<h2/);
});

test('replaceSection markdown table: XML outside the section is byte-identical', () => {
  const path = workCopy();
  const before = readFileSync(path, 'utf8');
  const marker = '<h2>Предметная область</h2>';
  const suffix = before.slice(before.indexOf(marker));
  const result = replaceSection(path, {
    headingIndex: 0,
    heading: 'Матрица оценки',
    bodyFormat: 'markdown',
    body: '| X | Y |\n| --- | --- |\n| 9 | 8 |',
  });
  assert.equal(result.ok, true);
  const after = readFileSync(path, 'utf8');
  const prefixEnd = before.indexOf('<h2><ac:inline-comment-marker');
  assert.equal(after.slice(0, prefixEnd), before.slice(0, prefixEnd));
  assert.equal(after.slice(after.indexOf(marker)), suffix);
  assert.match(after, /<table><tbody><tr><th>X<\/th><th>Y<\/th><\/tr>/);
  assert.match(after, /<td>9<\/td>/);
  assert.match(after, /<ac:plain-text-body><!\[CDATA\[flowchart LR\nA --> B\]\]>/);
  assert.equal(result.bytesAfter, Buffer.byteLength(after, 'utf8'));
});

test('replaceMacroBody mermaid: CDATA is not HTML-escaped', () => {
  const path = workCopy();
  const body = 'flowchart TB\nX --> Y';
  const result = replaceMacroBody(path, {
    name: 'mermaid-macro',
    parentHeading: 'Предметная область',
    bodyKind: 'plain',
    body,
  });
  assert.equal(result.ok, true);
  const xml = readFileSync(path, 'utf8');
  assert.match(xml, /<ac:plain-text-body><!\[CDATA\[flowchart TB\nX --> Y\]\]><\/ac:plain-text-body>/);
  assert.doesNotMatch(xml, /--&gt;/);
  assert.equal(result.bodyCharsAfter, body.length);
});

test('getSection: no maxChars returns full body', () => {
  const path = workCopy();
  const long = 'x'.repeat(9000);
  replaceSection(path, {
    heading: 'Предметная область',
    bodyFormat: 'markdown',
    body: long,
  });
  const sec = getSection(path, {
    heading: 'Предметная область',
    format: 'text',
  });
  assert.equal(sec.truncated, false);
  assert.ok(sec.body.length >= 9000);
});

test('getSection: maxChars truncates when set', () => {
  const path = workCopy();
  replaceSection(path, {
    heading: 'Предметная область',
    bodyFormat: 'markdown',
    body: 'y'.repeat(500),
  });
  const sec = getSection(path, {
    heading: 'Предметная область',
    format: 'text',
    maxChars: 100,
  });
  assert.equal(sec.truncated, true);
  assert.equal(sec.chars, 100);
  assert.equal(sec.body.length, 100);
});

test('ambiguous heading: error + candidates, file unchanged', () => {
  const path = workCopy();
  const before = readFileSync(path, 'utf8');
  assert.throws(
    () => getSection(path, { heading: 'Матрица оценки' }),
    (err) => {
      const payload = JSON.parse(err.message);
      assert.match(payload.error, /Ambiguous/);
      assert.equal(payload.candidates.length, 2);
      assert.equal(payload.candidates[0].index, 0);
      assert.equal(payload.candidates[1].index, 3);
      return true;
    },
  );
  assert.throws(
    () =>
      replaceSection(path, {
        heading: 'Матрица оценки',
        body: 'nope',
      }),
    /Ambiguous/,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('dryRun true: file unchanged, bytesAfter computed', () => {
  const path = workCopy();
  const before = readFileSync(path, 'utf8');
  const result = replaceSection(path, {
    heading: 'Предметная область',
    bodyFormat: 'markdown',
    body: 'Hello **world**',
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(result.bytesAfter > 0);
  assert.notEqual(result.bytesAfter, result.bytesBefore);
});

test('listMacros: no bodies, parentHeading, bodyKind', () => {
  const { macros } = listMacros(FIXTURE);
  const mermaid = macros.find((m) => m.name === 'mermaid-macro');
  const expand = macros.find((m) => m.name === 'expand');
  assert.equal(mermaid.parentHeading, 'Предметная область');
  assert.equal(mermaid.bodyKind, 'plain-text');
  assert.ok(mermaid.bodyChars > 0);
  assert.equal(mermaid.macroId, 'u1');
  assert.equal(expand.params.title, 'Скрыто');
  assert.equal(expand.bodyKind, 'rich');
  assert.ok(!('body' in mermaid));
});
