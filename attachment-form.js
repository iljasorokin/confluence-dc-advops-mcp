/**
 * Multipart form for Confluence DC attachment upload / new version.
 * Comment part must carry charset=UTF-8 so Tomcat does not read UTF-8 as ISO-8859-1.
 */

/**
 * @param {{
 *   buf: Buffer | Uint8Array,
 *   filename: string,
 *   comment?: string,
 *   minorEdit?: boolean,
 * }} opts
 * @returns {FormData}
 */
export function buildAttachmentUploadForm({ buf, filename, comment, minorEdit = true }) {
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  if (comment != null && comment !== '') {
    form.append(
      'comment',
      new Blob([Buffer.from(String(comment), 'utf8')], {
        type: 'text/plain; charset=UTF-8',
      }),
    );
  }
  form.append('minorEdit', String(Boolean(minorEdit)));
  return form;
}

/**
 * Serialize FormData the same way fetch would (for unit tests).
 * @param {FormData} form
 * @returns {Promise<{ contentType: string, body: Buffer }>}
 */
export async function serializeFormData(form) {
  const req = new Request('http://attachment.test/upload', {
    method: 'POST',
    body: form,
  });
  const contentType = req.headers.get('content-type') || '';
  const body = Buffer.from(await req.arrayBuffer());
  return { contentType, body };
}

/**
 * @param {Buffer} body
 * @param {string} fieldName
 * @returns {{ headers: string, value: Buffer } | null}
 */
export function extractMultipartPart(body, fieldName) {
  const raw = body.toString('latin1');
  const marker = `name="${fieldName}"`;
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const headersStart = raw.lastIndexOf('Content-Disposition:', start);
  const headersEnd = raw.indexOf('\r\n\r\n', start);
  if (headersStart < 0 || headersEnd < 0) return null;
  const headers = raw.slice(headersStart, headersEnd);
  const valueStart = headersEnd + 4;
  // Next boundary starts with \r\n--
  const next = raw.indexOf('\r\n--', valueStart);
  const valueEnd = next < 0 ? raw.length : next;
  return {
    headers,
    value: body.subarray(valueStart, valueEnd),
  };
}
