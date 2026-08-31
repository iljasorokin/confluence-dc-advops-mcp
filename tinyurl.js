/**
 * Confluence DC tiny links: /x/{code} encodes the page id as
 * little-endian uint32 → standard base64, then `/`→`-` and `+`→`_`
 * (Atlassian KB, not RFC4648 base64url). Padding `=` is omitted.
 * @see https://confluence.atlassian.com/confkb/how-to-programmatically-generate-the-tiny-link-of-a-confluence-page-956713432.html
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
 * Inverse of DC generation: `-`→`/`, `_`→`+`, standard base64, little-endian int.
 * @param {string} code
 * @returns {string}
 */
export function decodeTinyCode(code) {
  const c = String(code ?? '').trim();
  if (!TINY_CODE_RE.test(c)) {
    throw new Error(`Invalid tiny code: ${JSON.stringify(code)}`);
  }
  // Official DC alphabet (KB): not RFC4648 base64url (`-` is `/`, `_` is `+`).
  let b64 = c.replace(/-/g, '/').replace(/_/g, '+');
  // Encode may drop a trailing 'A' before `=` padding; restore if needed.
  while (b64.length % 4 === 1) b64 += 'A';
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new Error(`Invalid tiny code (base64): ${JSON.stringify(code)}`);
  }
  if (!buf.length || buf.length > 8) {
    throw new Error(`Invalid tiny code length for ${JSON.stringify(code)}`);
  }
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
 * Swap `-` and `_` (safety net if a client used RFC4648 base64url instead of DC alphabet).
 * @param {string} code
 * @returns {string}
 */
export function swapDashUnderscore(code) {
  return String(code ?? '')
    .replace(/-/g, '\0')
    .replace(/_/g, '-')
    .replace(/\0/g, '_');
}

/**
 * Decode candidates: primary code, then `-`↔`_` swap when applicable.
 * @param {string} code bare tiny code (not full URL)
 * @returns {Array<{ contentId: string, resolvedVia: 'decode' | 'decode-swapped', decodeCode: string }>}
 */
export function decodeTinyCodeCandidates(code) {
  const c = String(code ?? '').trim();
  const primaryId = decodeTinyCode(c);
  const out = [{ contentId: primaryId, resolvedVia: 'decode', decodeCode: c }];
  if (!/[-_]/.test(c)) return out;
  const swappedCode = swapDashUnderscore(c);
  if (swappedCode === c) return out;
  const swappedId = decodeTinyCode(swappedCode);
  if (swappedId !== primaryId) {
    out.push({
      contentId: swappedId,
      resolvedVia: 'decode-swapped',
      decodeCode: swappedCode,
    });
  }
  return out;
}

/**
 * Extract numeric page id from a Confluence redirect / view URL.
 * @param {string} url
 * @returns {string | null}
 */
export function parseContentIdFromLocation(url) {
  const s = String(url ?? '');
  const patterns = [
    /[?&]pageId=(\d+)/i,
    /\/content\/(\d+)(?:[/?#]|$)/i,
    /\/wiki\/(?:spaces\/[^/]+\/pages\/|pages\/)(\d+)(?:[/?#]|$)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolve tiny URL → page metadata using injected lookups (for tests + index.js).
 * @param {string} input
 * @param {{
 *   getPageById: (contentId: string) => Promise<object | null>,
 *   followTinyUrl?: (code: string) => Promise<{ contentId: string } | null>,
 * }} deps
 */
export async function resolveTinyUrlMeta(input, { getPageById, followTinyUrl }) {
  const code = extractTinyCode(input);
  const candidates = decodeTinyCodeCandidates(code);
  let last404;

  for (const cand of candidates) {
    let page;
    try {
      page = await getPageById(cand.contentId);
    } catch (err) {
      if (isConfluence404(err)) {
        last404 = err;
        continue;
      }
      throw err;
    }
    if (page) {
      return {
        page,
        code,
        contentId: String(page.id ?? cand.contentId),
        resolvedVia: cand.resolvedVia,
      };
    }
  }

  if (followTinyUrl) {
    const action = await followTinyUrl(code);
    if (action?.contentId) {
      let page;
      try {
        page = await getPageById(action.contentId);
      } catch (err) {
        if (isConfluence404(err)) last404 = err;
        else throw err;
      }
      if (page) {
        return {
          page,
          code,
          contentId: String(page.id ?? action.contentId),
          resolvedVia: 'tinyurl-action',
        };
      }
    }
  }

  if (last404) throw last404;
  throw new Error(
    `Could not resolve Confluence tiny code ${JSON.stringify(code)} (decode and tinyurl.action failed)`,
  );
}

/** @param {unknown} err */
export function isConfluence404(err) {
  return err instanceof Error && /→ 404:/.test(err.message);
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
