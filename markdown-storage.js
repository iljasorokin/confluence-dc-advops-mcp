/**
 * Minimal markdown ↔ Confluence storage for a *section* (not a full page).
 * Does not convert mermaid / layout / images / Jira / details.
 */

const PLACEHOLDER = (i) => `\u0000PH${i}\u0000`;

export function markdownToStorage(md) {
  const raw = String(md ?? '');
  if (/<ac:/i.test(raw)) {
    throw new Error(
      'Markdown body contains <ac: XML. Use bodyFormat: storage or confluence_storage_replaceMacroBody.',
    );
  }
  if (/<(html|body)\b/i.test(raw)) {
    throw new Error('Section body must not include <html> or <body> wrappers.');
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(codeMacro(buf.join('\n'), lang));
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [line];
      i += 1;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      blocks.push(tableToStorage(rows));
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const level = hm[1].length;
      blocks.push(`<h${level}>${inlineToStorage(hm[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push(
        `<ul>${items.map((t) => `<li>${inlineToStorage(t)}</li>`).join('')}</ul>`,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        `<ol>${items.map((t) => `<li>${inlineToStorage(t)}</li>`).join('')}</ol>`,
      );
      continue;
    }
    const para = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !isTableRow(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${inlineToStorage(para.join('\n').replace(/\n/g, ' '))}</p>`);
  }
  return blocks.join('\n');
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitCells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

function tableToStorage(rows) {
  const header = splitCells(rows[0]);
  const bodyRows = rows.slice(2).map(splitCells);
  const th = header.map((c) => `<th>${inlineToStorage(c)}</th>`).join('');
  const trs = [
    `<tr>${th}</tr>`,
    ...bodyRows.map(
      (cells) =>
        `<tr>${cells.map((c) => `<td>${inlineToStorage(c)}</td>`).join('')}</tr>`,
    ),
  ];
  return `<table><tbody>${trs.join('')}</tbody></table>`;
}

function codeMacro(code, language) {
  const langParam = language
    ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`
    : '';
  if (code.includes(']]>')) {
    throw new Error('Code fence body contains ]]> which cannot go in CDATA');
  }
  return `<ac:structured-macro ac:name="code" ac:schema-version="1">${langParam}<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;
}

function inlineToStorage(text) {
  const parts = [];
  let s = String(text ?? '');
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const i = parts.length;
    parts.push(`<code>${escapeXml(code)}</code>`);
    return PLACEHOLDER(i);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const i = parts.length;
    parts.push(
      `<a href="${escapeXml(href)}">${escapeXml(label)}</a>`,
    );
    return PLACEHOLDER(i);
  });
  s = escapeXml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/\u0000PH(\d+)\u0000/g, (_, n) => parts[Number(n)]);
  return s;
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function decodeXmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
