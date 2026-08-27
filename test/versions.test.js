import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeVersion,
  buildVersionsListPath,
  buildHistoricalContentPath,
} from '../versions.js';

test('summarizeVersion: author and message', () => {
  const row = summarizeVersion({
    number: 12,
    when: '2026-08-24T10:00:00.000Z',
    message: 'fix AC',
    minorEdit: false,
    by: { username: 'alice', displayName: 'Alice A', userKey: 'uk1' },
  });
  assert.deepEqual(row, {
    number: 12,
    when: '2026-08-24T10:00:00.000Z',
    message: 'fix AC',
    minorEdit: false,
    by: { username: 'alice', displayName: 'Alice A', userKey: 'uk1' },
  });
});

test('buildVersionsListPath clamps limit', () => {
  assert.equal(
    buildVersionsListPath('99', { start: 10, limit: 500 }),
    '/rest/api/content/99/version?start=10&limit=200',
  );
  assert.equal(
    buildVersionsListPath('99', { limit: 0 }),
    '/rest/api/content/99/version?start=0&limit=1',
  );
});

test('buildHistoricalContentPath requires positive version', () => {
  assert.equal(
    buildHistoricalContentPath('42', 3),
    '/rest/api/content/42?status=historical&version=3&expand=body.storage%2Cversion%2Cspace',
  );
  assert.throws(() => buildHistoricalContentPath('42', 0), /positive integer/);
});
