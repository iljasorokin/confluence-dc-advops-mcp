/**
 * Surgical edits of Confluence storage XML on disk.
 * Unmodified ranges are copied from the original string (no full-document reserialize).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseDocument } from 'htmlparser2';
import { markdownToStorage, escapeXml, decodeXmlEntities } from './markdown-storage.js';

const HEADING_RE = /^h([1-6])$/i;

export function loadStorageFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const xml = readFileSync(filePath, 'utf8');
  if (!xml.trim()) throw new Error(`File is empty: ${filePath}`);
  let dom;
  try {
    dom = parseDocument(xml, {
      xmlMode: true,
      withStartIndices: true,
      withEndIndices: true,
      decodeEntities: false,
    });
  } catch (error) {
    throw new Error(`Failed to parse storage XML: ${error.message}`);
  }
  return { filePath, xml, bytes: Buffer.byteLength(xml, 'utf8'), dom };
}

function walk(node, fn) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  fn(node);
  if (node.children?.length) walk(node.children, fn);
}

function tagName(node) {
  return node?.type === 'tag' ? String(node.name || '') : '';
}

function visibleText(node) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'cdata') {
    return decodeXmlEntities(node.data || '');
  }
  if (node.type !== 'tag') return '';
  const name = tagName(node);
  if (name === 'ac:inline-comment-marker') return '';
  if (name === 'br') return ' ';
  return (node.children || []).map(visibleText).join('');
}

function normalizeHeading(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectHeadings(dom) {
  const headings = [];
  walk(dom, (node) => {
    const m = tagName(node).match(HEADING_RE);
    if (!m) return;
    if (node.startIndex == null || node.endIndex == null) return;
    headings.push({
      index: headings.length,
      level: Number(m[1]),
      text: normalizeHeading(visibleText(node)),
      offset: node.startIndex,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
    });
  });
  return headings;
}

function headingCandidates(headings) {
  return headings.map((h) => ({
    index: h.index,
    level: h.level,
    text: h.text,
  }));
}

function headingError(message, headings) {
  const err = new Error(
    JSON.stringify({ error: message, candidates: headingCandidates(headings) }, null, 2),
  );
  err.candidates = headingCandidates(headings);
  return err;
}

export function resolveHeading(headings, { heading, headingIndex } = {}) {
  if (headingIndex != null) {
    const h = headings[headingIndex];
    if (!h) {
      throw headingError(
        `headingIndex ${headingIndex} out of range (0..${Math.max(0, headings.length - 1)})`,
        headings,
      );
    }
    if (heading != null && normalizeHeading(heading) !== h.text) {
      throw headingError(
        `headingIndex ${headingIndex} is "${h.text}", not "${normalizeHeading(heading)}"`,
        headings,
      );
    }
    return h;
  }
  if (heading == null || heading === '') {
    throw new Error('Provide heading and/or headingIndex');
  }
  const want = normalizeHeading(heading);
  const matches = headings.filter((h) => h.text === want);
  if (matches.length === 0) {
    throw headingError(`Heading not found: ${heading}`, headings);
  }
  if (matches.length > 1) {
    throw headingError(
      `Ambiguous heading "${heading}" (${matches.length} matches). Pass headingIndex.`,
      matches,
    );
  }
  return matches[0];
}

function sectionRange(xml, headings, heading, includeHeading) {
  const next = headings.find(
    (x) => x.index > heading.index && x.level <= heading.level,
  );
  const start = includeHeading ? heading.startIndex : heading.endIndex + 1;
  const end = next ? next.startIndex : xml.length;
  return { start, end, next };
}

export function listHeadings(filePath) {
  const { xml, bytes, filePath: fp, dom } = loadStorageFile(filePath);
  const headings = collectHeadings(dom);
  return {
    filePath: fp,
    bytes,
    headings: headings.map((h) => ({
      index: h.index,
      level: h.level,
      text: h.text,
      offset: h.offset,
    })),
  };
}

function attr(node, name) {
  return node?.attribs?.[name] ?? node?.attribs?.[name.toLowerCase()];
}

function nodeTextContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  if (node.type === 'cdata') {
    return node.data || (node.children || []).map(nodeTextContent).join('');
  }
  return (node.children || []).map(nodeTextContent).join('');
}

function hasElementChild(node) {
  return (node.children || []).some((c) => c.type === 'tag');
}

function collectMacros(dom, xml) {
  const headings = collectHeadings(dom);
  const macros = [];
  walk(dom, (node) => {
    const name = tagName(node);
    if (name !== 'ac:structured-macro' && name !== 'ac:macro') return;
    if (node.startIndex == null || node.endIndex == null) return;
    const preceding = [...headings]
      .reverse()
      .find((h) => h.startIndex < node.startIndex);
    let bodyKind = 'none';
    let bodyChars = 0;
    let bodyNode = null;
    for (const child of node.children || []) {
      const cn = tagName(child);
      if (cn === 'ac:plain-text-body') {
        bodyKind = 'plain-text';
        bodyChars = nodeTextContent(child).length;
        bodyNode = child;
      } else if (cn === 'ac:rich-text-body') {
        bodyKind = 'rich';
        bodyChars = nodeTextContent(child).length;
        bodyNode = child;
      }
    }
    const params = {};
    for (const child of node.children || []) {
      if (tagName(child) !== 'ac:parameter') continue;
      const pname = attr(child, 'ac:name');
      if (!pname) continue;
      params[pname] = hasElementChild(child)
        ? '(rich)'
        : decodeXmlEntities(nodeTextContent(child));
    }
    macros.push({
      index: macros.length,
      name: attr(node, 'ac:name') || '',
      macroId: attr(node, 'ac:macro-id') || null,
      schemaVersion: attr(node, 'ac:schema-version') || null,
      params,
      parentHeading: preceding ? preceding.text : null,
      bodyChars,
      bodyKind,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      bodyNode,
    });
  });
  return { headings, macros, xml };
}

/** Expand is a collapsed rich-text wrapper (KTalk transcripts). Unwrap body; skip title param. */
function isUnwrapMacro(node) {
  return (attr(node, 'ac:name') || '').toLowerCase() === 'expand';
}

function eachMacroBody(node, fn) {
  let found = false;
  for (const child of node.children || []) {
    const cn = tagName(child);
    if (cn === 'ac:rich-text-body' || cn === 'ac:plain-text-body') {
      fn(child);
      found = true;
    }
  }
  return found;
}

function storageToText(xmlFragment) {
  let dom;
  try {
    dom = parseDocument(xmlFragment, {
      xmlMode: true,
      decodeEntities: false,
    });
  } catch {
    return decodeXmlEntities(xmlFragment.replace(/<[^>]+>/g, ' '));
  }
  const out = [];
  function emit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) emit(n);
      return;
    }
    if (node.type === 'text' || node.type === 'cdata') {
      out.push(decodeXmlEntities(node.data || ''));
      return;
    }
    if (node.type !== 'tag') return;
    const name = tagName(node);
    if (HEADING_RE.test(name)) {
      out.push('\n\n', visibleText(node), '\n');
      return;
    }
    if (name === 'br') {
      out.push('\n');
      return;
    }
    if (name === 'p' || name === 'div') {
      emit(node.children);
      out.push('\n');
      return;
    }
    if (name === 'li') {
      out.push('\n- ');
      emit(node.children);
      return;
    }
    if (name === 'tr') {
      const cells = (node.children || []).filter(
        (c) => c.type === 'tag' && (tagName(c) === 'td' || tagName(c) === 'th'),
      );
      out.push('\n', cells.map((c) => visibleText(c).trim()).join(' | '));
      return;
    }
    if (name === 'ac:structured-macro' || name === 'ac:macro') {
      if (isUnwrapMacro(node) && eachMacroBody(node, (body) => emit(body.children))) {
        return;
      }
      out.push(`[macro: ${attr(node, 'ac:name') || name}]`);
      return;
    }
    if (name === 'ac:inline-comment-marker') return;
    emit(node.children);
  }
  emit(dom.children || [dom]);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function storageToMarkdown(xmlFragment) {
  let dom;
  try {
    dom = parseDocument(xmlFragment, {
      xmlMode: true,
      decodeEntities: false,
    });
  } catch {
    return storageToText(xmlFragment);
  }
  const out = [];
  function inlineMd(node) {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(inlineMd).join('');
    if (node.type === 'text' || node.type === 'cdata') {
      return decodeXmlEntities(node.data || '');
    }
    if (node.type !== 'tag') return '';
    const name = tagName(node);
    if (name === 'strong' || name === 'b') return `**${inlineMd(node.children)}**`;
    if (name === 'em' || name === 'i') return `*${inlineMd(node.children)}*`;
    if (name === 'code') return `\`${inlineMd(node.children)}\``;
    if (name === 'a') {
      const href = attr(node, 'href') || '';
      return `[${inlineMd(node.children)}](${href})`;
    }
    if (name === 'br') return '  \n';
    if (name === 'ac:structured-macro' || name === 'ac:macro') {
      if (isUnwrapMacro(node)) {
        const parts = [];
        eachMacroBody(node, (body) => parts.push(inlineMd(body.children)));
        if (parts.length) return parts.join('');
      }
      return `[macro: ${attr(node, 'ac:name') || name}]`;
    }
    if (name === 'ac:inline-comment-marker') return '';
    return inlineMd(node.children);
  }
  function emit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) emit(n);
      return;
    }
    if (node.type === 'text' || node.type === 'cdata') {
      const t = decodeXmlEntities(node.data || '');
      if (t.trim()) out.push(t);
      return;
    }
    if (node.type !== 'tag') return;
    const name = tagName(node);
    const hm = name.match(HEADING_RE);
    if (hm) {
      out.push('\n\n', `${'#'.repeat(Number(hm[1]))} ${visibleText(node)}`, '\n\n');
      return;
    }
    if (name === 'p') {
      out.push('\n\n', inlineMd(node.children), '\n\n');
      return;
    }
    if (name === 'ul') {
      for (const li of node.children || []) {
        if (tagName(li) === 'li') out.push('\n- ', inlineMd(li.children));
      }
      out.push('\n');
      return;
    }
    if (name === 'ol') {
      let n = 1;
      for (const li of node.children || []) {
        if (tagName(li) === 'li') {
          out.push('\n', `${n}. `, inlineMd(li.children));
          n += 1;
        }
      }
      out.push('\n');
      return;
    }
    if (name === 'table') {
      const rows = [];
      walk(node, (el) => {
        if (tagName(el) === 'tr') {
          const cells = (el.children || []).filter(
            (c) => tagName(c) === 'td' || tagName(c) === 'th',
          );
          rows.push(cells.map((c) => visibleText(c).trim()));
        }
      });
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r) => {
          const x = [...r];
          while (x.length < width) x.push('');
          return x;
        };
        const head = pad(rows[0]);
        out.push('\n\n', '| ', head.join(' | '), ' |\n');
        out.push('| ', head.map(() => '---').join(' | '), ' |\n');
        for (const r of rows.slice(1)) {
          out.push('| ', pad(r).join(' | '), ' |\n');
        }
        out.push('\n');
      }
      return;
    }
    if (name === 'ac:structured-macro' || name === 'ac:macro') {
      if (isUnwrapMacro(node) && eachMacroBody(node, (body) => emit(body.children))) {
        return;
      }
      out.push(`\n\n[macro: ${attr(node, 'ac:name') || name}]\n\n`);
      return;
    }
    emit(node.children);
  }
  emit(dom.children || [dom]);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveMaxChars(maxChars) {
  if (maxChars == null) return null;
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function applyMax(text, maxChars, format) {
  if (maxChars == null) {
    return { body: text, truncated: false, chars: text.length };
  }
  if (format === 'storage' && text.length > maxChars) {
    throw new Error(
      `section larger than maxChars (${text.length} > ${maxChars}), use format: text`,
    );
  }
  if (text.length > maxChars) {
    return { body: text.slice(0, maxChars), truncated: true, chars: maxChars };
  }
  return { body: text, truncated: false, chars: text.length };
}

export function getSection(filePath, opts = {}) {
  const includeHeading = opts.includeHeading !== false;
  const format = opts.format || 'text';
  const maxChars = resolveMaxChars(opts.maxChars);
  const { xml, filePath: fp, dom } = loadStorageFile(filePath);
  const headings = collectHeadings(dom);
  const heading = resolveHeading(headings, opts);
  const { start, end } = sectionRange(xml, headings, heading, includeHeading);
  const slice = xml.slice(start, end);
  let rendered = slice;
  if (format === 'text') rendered = storageToText(slice);
  else if (format === 'markdown') rendered = storageToMarkdown(slice);
  else if (format !== 'storage') {
    throw new Error(`Unknown format: ${format}`);
  }
  const capped = applyMax(rendered, maxChars, format);
  return {
    filePath: fp,
    heading: heading.text,
    headingIndex: heading.index,
    level: heading.level,
    format,
    ...capped,
  };
}

function prefixBody(body) {
  const s = String(body ?? '');
  if (!s) return '\n';
  return s.startsWith('\n') ? s : `\n${s}`;
}

export function replaceSection(filePath, opts = {}) {
  const bodyFormat = opts.bodyFormat || 'markdown';
  const dryRun = Boolean(opts.dryRun);
  const replaceHeading = Boolean(opts.replaceHeading);
  const { xml, bytes, filePath: fp, dom } = loadStorageFile(filePath);
  const headings = collectHeadings(dom);
  const heading = resolveHeading(headings, opts);
  const { end } = sectionRange(xml, headings, heading, false);

  let newInner;
  if (bodyFormat === 'markdown') {
    newInner = markdownToStorage(opts.body);
  } else if (bodyFormat === 'storage') {
    const raw = String(opts.body ?? '');
    if (/<(html|body)\b/i.test(raw)) {
      throw new Error('Storage fragment must not include <html> or <body>.');
    }
    newInner = raw;
  } else {
    throw new Error(`Unknown bodyFormat: ${bodyFormat}`);
  }

  const headingXml =
    replaceHeading && opts.newHeading != null
      ? `<h${heading.level}>${escapeXml(opts.newHeading)}</h${heading.level}>`
      : xml.slice(heading.startIndex, heading.endIndex + 1);
  const nextXml =
    xml.slice(0, heading.startIndex) +
    headingXml +
    prefixBody(newInner) +
    xml.slice(end);
  const bytesAfter = Buffer.byteLength(nextXml, 'utf8');
  if (!dryRun) writeFileSync(fp, nextXml, 'utf8');

  const previewSource = prefixBody(newInner);
  let previewText = storageToText(headingXml + previewSource);
  if (previewText.length > 400) previewText = previewText.slice(0, 400);

  return {
    ok: true,
    filePath: fp,
    bytesBefore: bytes,
    bytesAfter,
    dryRun,
    heading: replaceHeading && opts.newHeading != null
      ? normalizeHeading(opts.newHeading)
      : heading.text,
    headingIndex: heading.index,
    note: replaceHeading ? 'replaced heading and section body' : 'replaced section body; heading kept',
    previewText,
  };
}

export function listMacros(filePath, { name } = {}) {
  const { filePath: fp, bytes, xml, dom } = loadStorageFile(filePath);
  let { macros } = collectMacros(dom, xml);
  if (name) macros = macros.filter((m) => m.name === name);
  return {
    filePath: fp,
    bytes,
    count: macros.length,
    macros: macros.map((m) => ({
      index: m.index,
      name: m.name,
      macroId: m.macroId,
      schemaVersion: m.schemaVersion,
      params: m.params,
      parentHeading: m.parentHeading,
      bodyChars: m.bodyChars,
      bodyKind: m.bodyKind,
    })),
  };
}

function macroCandidates(macros) {
  return macros.map((m) => ({
    index: m.index,
    name: m.name,
    parentHeading: m.parentHeading,
    macroId: m.macroId,
  }));
}

function macroError(message, macros) {
  return new Error(
    JSON.stringify({ error: message, candidates: macroCandidates(macros) }, null, 2),
  );
}

export function replaceMacroBody(filePath, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const bodyKind = opts.bodyKind || 'plain';
  const { xml, bytes, filePath: fp, dom } = loadStorageFile(filePath);
  const { macros } = collectMacros(dom, xml);

  const hasId = opts.macroId != null && opts.macroId !== '';
  const hasNameHeading = Boolean(opts.name) && opts.parentHeading !== undefined;
  const hasNameIndex = Boolean(opts.name) && opts.index != null;
  const nsel = [hasId, hasNameHeading, hasNameIndex].filter(Boolean).length;
  if (nsel !== 1) {
    throw new Error(
      'Provide exactly one selector: macroId, or name+parentHeading, or name+index',
    );
  }

  let matches;
  if (hasId) {
    matches = macros.filter((m) => m.macroId === String(opts.macroId));
  } else if (hasNameIndex) {
    matches = macros.filter(
      (m) => m.name === opts.name && m.index === Number(opts.index),
    );
  } else {
    const want = opts.parentHeading == null ? null : normalizeHeading(opts.parentHeading);
    matches = macros.filter(
      (m) =>
        m.name === opts.name &&
        (m.parentHeading == null ? want == null : m.parentHeading === want),
    );
  }
  if (matches.length !== 1) {
    throw macroError(
      matches.length === 0
        ? 'Macro not found'
        : `Ambiguous macro (${matches.length} matches)`,
      matches.length ? matches : macros,
    );
  }
  const macro = matches[0];
  const body = String(opts.body ?? '');
  if (bodyKind === 'plain' && body.includes(']]>')) {
    throw new Error('Macro body contains ]]> which cannot go in CDATA');
  }

  let nextXml;
  if (bodyKind === 'plain') {
    const replacement = `<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body>`;
    if (macro.bodyNode && tagName(macro.bodyNode) === 'ac:plain-text-body') {
      nextXml =
        xml.slice(0, macro.bodyNode.startIndex) +
        replacement +
        xml.slice(macro.bodyNode.endIndex + 1);
    } else {
      const close = xml.lastIndexOf('</', macro.endIndex);
      nextXml = xml.slice(0, close) + replacement + xml.slice(close);
    }
  } else if (bodyKind === 'rich') {
    const replacement = `<ac:rich-text-body>${body}</ac:rich-text-body>`;
    if (macro.bodyNode && tagName(macro.bodyNode) === 'ac:rich-text-body') {
      nextXml =
        xml.slice(0, macro.bodyNode.startIndex) +
        replacement +
        xml.slice(macro.bodyNode.endIndex + 1);
    } else {
      const close = xml.lastIndexOf('</', macro.endIndex);
      nextXml = xml.slice(0, close) + replacement + xml.slice(close);
    }
  } else {
    throw new Error(`Unknown bodyKind: ${bodyKind}`);
  }

  const bytesAfter = Buffer.byteLength(nextXml, 'utf8');
  if (!dryRun) writeFileSync(fp, nextXml, 'utf8');
  let previewText = bodyKind === 'plain' ? body : storageToText(body);
  if (previewText.length > 200) previewText = previewText.slice(0, 200);

  return {
    ok: true,
    filePath: fp,
    bytesBefore: bytes,
    bytesAfter,
    dryRun,
    name: macro.name,
    macroId: macro.macroId,
    bodyCharsAfter: body.length,
    previewText,
    note: 'replaced macro body; wrapper and parameters kept',
  };
}
