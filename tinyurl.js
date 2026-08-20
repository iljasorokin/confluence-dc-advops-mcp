/**
 * Confluence DC tiny links: /x/{code} encodes the page id as
 * URL-safe base64 of the little-endian integer (padding often omitted).
 */

const TINY_PATH_RE = /(?:^|\/)x\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const TINY_QUERY_RE = /[?&]urlIdentifier=([A-Za-z0-9_-]+)/i;
const TINY_CODE_RE = /^[A-Za-z0-9_-]{2,32}$/;

/**
 * Extract tiny code from a full URL, path, or bare identifier.
 * @param {string} input
 * @returns {string}
 */
export function extractTinyCode(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('tiny URL / code is empty');

  const fromPath = raw.match(TINY_PATH_RE);
  if (fromPath) return fromPath[1];

  const fromQuery = raw.match(TINY_QUERY_RE);
  if (fromQuery) return fromQuery[1];

  // Bare code (no scheme/path)
  if (TINY_CODE_RE.test(raw) && !raw.includes('/') && !raw.includes('.')) {
    return raw;
  }

  throw new Error(
    `Cannot parse Confluence tiny URL from ${JSON.stringify(raw)}. ` +
      'Expected https://…/x/{code}, /x/{code}, or the bare code.',
  );
}

/**
 * Decode tiny code → numeric content id (string).
 * @param {string} code
 * @returns {string}
 */
export function decodeTinyCode(code) {
  const c = String(code ?? '').trim();
  if (!TINY_CODE_RE.test(c)) {
    throw new Error(`Invalid tiny code: ${JSON.stringify(code)}`);
  }
  const pad = c + '='.repeat((4 - (c.length % 4)) % 4);
  let buf;
  try {
    buf = Buffer.from(pad, 'base64url');
  } catch {
    throw new Error(`Invalid tiny code (base64): ${JSON.stringify(code)}`);
  }
  if (!buf.length || buf.length > 8) {
    throw new Error(`Invalid tiny code length for ${JSON.stringify(code)}`);
  }
  // Little-endian unsigned int
  let id = 0n;
  for (let i = 0; i < buf.length; i++) {
    id |= BigInt(buf[i]) << BigInt(8 * i);
  }
  if (id <= 0n || id > 0xffffffffn) {
    throw new Error(`Decoded tiny id out of range for ${JSON.stringify(code)}`);
  }
  return String(id);
}

/**
 * @param {string} input URL, /x/code, or bare code
 * @returns {{ code: string, contentId: string }}
 */
export function resolveTinyInput(input) {
  const code = extractTinyCode(input);
  const contentId = decodeTinyCode(code);
  return { code, contentId };
}
