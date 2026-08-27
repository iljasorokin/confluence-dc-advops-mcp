/**
 * Page version listing / historical storage paths for Confluence DC REST.
 * Pure helpers + URL builders (no network) for unit tests.
 */

/**
 * Compact version row for agents (no content body).
 * @param {object} v raw version from /rest/api/content/{id}/version
 */
export function summarizeVersion(v) {
  if (!v || typeof v !== 'object') {
    throw new Error('Invalid version object');
  }
  const by = v.by || {};
  return {
    number: v.number,
    when: v.when ?? null,
    message: v.message ?? '',
    minorEdit: Boolean(v.minorEdit),
    by: {
      username: by.username ?? '',
      displayName: by.displayName ?? '',
      ...(by.userKey ? { userKey: by.userKey } : {}),
    },
  };
}

/**
 * @param {string|number} contentId
 * @param {{ start?: number, limit?: number }} [opts]
 */
export function buildVersionsListPath(contentId, { start = 0, limit = 50 } = {}) {
  const rawLim = Number(limit);
  const lim = Math.min(200, Math.max(1, Number.isFinite(rawLim) ? rawLim : 50));
  const rawStart = Number(start);
  const st = Math.max(0, Number.isFinite(rawStart) ? rawStart : 0);
  const qs = new URLSearchParams({
    start: String(st),
    limit: String(lim),
  });
  return `/rest/api/content/${contentId}/version?${qs.toString()}`;
}

/**
 * Historical page body (DC).
 * @param {string|number} contentId
 * @param {number} versionNumber
 * @param {string} [expand]
 */
export function buildHistoricalContentPath(
  contentId,
  versionNumber,
  expand = 'body.storage,version,space',
) {
  const n = Number(versionNumber);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`version must be a positive integer, got ${versionNumber}`);
  }
  const qs = new URLSearchParams({
    status: 'historical',
    version: String(n),
    expand,
  });
  return `/rest/api/content/${contentId}?${qs.toString()}`;
}
