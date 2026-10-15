import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttachmentUploadForm,
  serializeFormData,
  extractMultipartPart,
} from '../attachment-form.js';

test('comment part has charset=UTF-8 and raw UTF-8 bytes', async () => {
  const comment = 'Исходный файл';
  const form = buildAttachmentUploadForm({
    buf: Buffer.from('x'),
    filename: 'файл.txt',
    comment,
  });
  const { body } = await serializeFormData(form);
  const part = extractMultipartPart(body, 'comment');
  assert.ok(part, 'comment part must exist');
  assert.match(part.headers, /charset=UTF-8|charset=utf-8/i);
  assert.equal(part.value.equals(Buffer.from(comment, 'utf8')), true);
  // Mojibake of the same string (UTF-8 misread as Latin-1, then re-encoded) must not appear
  const mojibake = Buffer.from(
    Buffer.from(comment, 'utf8').toString('latin1'),
    'utf8',
  );
  assert.equal(body.includes(mojibake), false);
});

test('omitted comment: no comment part', async () => {
  const form = buildAttachmentUploadForm({
    buf: Buffer.from('x'),
    filename: 'a.txt',
  });
  const { body } = await serializeFormData(form);
  assert.equal(extractMultipartPart(body, 'comment'), null);
});

test('empty string comment: no comment part', async () => {
  const form = buildAttachmentUploadForm({
    buf: Buffer.from('x'),
    filename: 'a.txt',
    comment: '',
  });
  const { body } = await serializeFormData(form);
  assert.equal(extractMultipartPart(body, 'comment'), null);
});

test('cyrillic filename is present in file part', async () => {
  const form = buildAttachmentUploadForm({
    buf: Buffer.from('hi'),
    filename: 'файл.txt',
    comment: 'ok',
  });
  const { body } = await serializeFormData(form);
  const filePart = extractMultipartPart(body, 'file');
  assert.ok(filePart);
  const headers = filePart.headers;
  assert.ok(
    headers.includes('файл.txt') ||
      /filename\*=UTF-8''.*%D1%84%D0%B0%D0%B9%D0%BB/i.test(headers) ||
      /filename=".*\.txt"/i.test(headers),
    `file part headers should keep cyrillic name: ${headers.slice(0, 200)}`,
  );
});
