#!/usr/bin/env node
/**
 * Local Confluence DC helpers for Cursor:
 * - move/reparent pages (until upstream parentId lands)
 * - reorder sibling pages (DC UI movepage.action: above / below / append)
 * - dump/update page storage from/to a local file (large templates without stuffing XML into chat)
 * - surgical section/macro edits on a local storage XML file (no full XML in chat)
 * - list / download / upload page attachments (binary via local file)
 * - list / dump / create / update / delete space page templates (Create from template)
 * - sync catalog page → space template in one call (body + labels)
 * - list / add / remove / set page labels; set labels on space templates
 *   (Create from template copies template labels onto the new page)
 * - list / add / reply to page footer comments (quotes in body; no create-inline)
 * - list inline comments (open on page vs resolved) and reply in their threads
 * - resolve Confluence tiny links (/x/…) to page id (Atlassian DC base64, swap on 404, tinyurl.action fallback)
 * - list page versions (who/when/message) and dump a historical version to a local file
 *
 * Auth/host: same as @atlassian-dc-mcp/confluence (local TLS proxy + keychain token).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  listHeadings as storageListHeadings,
  getSection as storageGetSection,
  replaceSection as storageReplaceSection,
  listMacros as storageListMacros,
  replaceMacroBody as storageReplaceMacroBody,
} from './storage.js';
import { resolveTinyUrlMeta, parseContentIdFromLocation } from './tinyurl.js';
import {
  summarizeVersion,
  buildVersionsListPath,
  buildHistoricalContentPath,
} from './versions.js';

const ENV_FILE = join(homedir(), '.atlassian-dc-mcp', 'confluence.env');
const KEYCHAIN_SERVICE = 'atlassian-dc-mcp';
const KEYCHAIN_ACCOUNT = 'confluence-token';

function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function resolveHost() {
  const fromEnv = process.env.CONFLUENCE_HOST?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const fromFile = loadEnvFile().CONFLUENCE_HOST?.trim();
  if (fromFile) return fromFile.replace(/\/$/, '');
  throw new Error('CONFLUENCE_HOST is not set (env or ~/.atlassian-dc-mcp/confluence.env)');
}

function resolveToken() {
  if (process.env.CONFLUENCE_API_TOKEN?.trim()) {
    return process.env.CONFLUENCE_API_TOKEN.trim();
  }
  const fromFile = loadEnvFile().CONFLUENCE_API_TOKEN?.trim();
  if (fromFile) return fromFile;
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
    } catch {
      // fall through
    }
  }
  throw new Error(
    'CONFLUENCE_API_TOKEN is not set (env, confluence.env, or macOS keychain atlassian-dc-mcp/confluence-token)',
  );
}

async function confluenceApi(method, path, body) {
  const host = resolveHost();
  const token = resolveToken();
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data?.message
      ? data.message
      : text.slice(0, 500);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

/** Binary/multipart fetch (no JSON Content-Type). Follows redirects. */
async function confluenceFetchRaw(method, path, { headers = {}, body } = {}) {
  const host = resolveHost();
  const token = resolveToken();
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Atlassian-Token': 'no-check',
      ...headers,
    },
    body,
    redirect: 'follow',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function templateStorage(template) {
  return template?.body?.storage?.value ?? template?.body?.value ?? null;
}

function summarizeTemplate(t, { includeBodyHash = false } = {}) {
  const storage = templateStorage(t);
  const out = {
    templateId: String(t.templateId),
    name: t.name,
    description: t.description || '',
    templateType: t.templateType,
    spaceKey: t.space?.key,
    labels: (t.labels || []).map((l) => l.name),
    bodyChars: storage ? storage.length : undefined,
  };
  if (includeBodyHash && storage) out.bodySha256 = sha256(storage);
  return out;
}

function summarizeLabel(l) {
  const out = {
    prefix: l.prefix || 'global',
    name: l.name,
  };
  if (l.id != null) out.id = String(l.id);
  return out;
}

/** Normalize tool input (`["a"]` or `[{name, prefix}]`) to DC label objects. */
function toLabelPayload(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  const seen = new Set();
  for (const l of labels) {
    let prefix = 'global';
    let name = '';
    if (typeof l === 'string') {
      name = l.trim();
    } else if (l && typeof l === 'object') {
      prefix = l.prefix || 'global';
      name = String(l.name || '').trim();
    }
    if (!name) continue;
    const key = `${prefix}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ prefix, name });
  }
  return out;
}

function asResults(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

async function listContentLabels(contentId, { prefix } = {}) {
  const results = [];
  let start = 0;
  const limit = 200;
  for (;;) {
    const qs = new URLSearchParams({
      start: String(start),
      limit: String(limit),
    });
    if (prefix) qs.set('prefix', prefix);
    const data = await confluenceApi(
      'GET',
      `/rest/api/content/${contentId}/label?${qs.toString()}`,
    );
    const batch = asResults(data);
    results.push(...batch);
    const total = data.totalSize ?? start + batch.length;
    start += data.size ?? batch.length;
    if (!batch.length || start >= total) break;
    if (start > 2000) break;
  }
  let labels = results.map(summarizeLabel);
  if (prefix) labels = labels.filter((l) => l.prefix === prefix);
  return labels;
}

async function addContentLabels(contentId, labels) {
  const payload = toLabelPayload(labels);
  if (!payload.length) throw new Error('Provide at least one label name');
  await confluenceApi('POST', `/rest/api/content/${contentId}/label`, payload);
  return {
    contentId: String(contentId),
    added: payload.map((l) => l.name),
    labels: await listContentLabels(contentId),
  };
}

async function removeContentLabels(contentId, labels) {
  const payload = toLabelPayload(labels);
  if (!payload.length) throw new Error('Provide at least one label name');
  const results = [];
  for (const l of payload) {
    const qs = new URLSearchParams({ name: l.name, prefix: l.prefix });
    try {
      await confluenceApi(
        'DELETE',
        `/rest/api/content/${contentId}/label?${qs.toString()}`,
      );
      results.push({ ok: true, prefix: l.prefix, name: l.name });
    } catch (error) {
      results.push({
        ok: false,
        prefix: l.prefix,
        name: l.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    contentId: String(contentId),
    requested: payload.length,
    removed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => r.ok === false).length,
    results,
    labels: await listContentLabels(contentId),
  };
}

/**
 * Replace labels of one prefix (default global). Leaves other prefixes (e.g. my) untouched.
 */
async function setContentLabels(contentId, labels, { prefix = 'global' } = {}) {
  const desired = toLabelPayload(labels).filter((l) => l.prefix === prefix);
  const current = await listContentLabels(contentId, { prefix });
  const desiredNames = new Set(desired.map((l) => l.name));
  const currentNames = new Set(current.map((l) => l.name));
  const toAdd = desired.filter((l) => !currentNames.has(l.name));
  const toRemove = current.filter((l) => !desiredNames.has(l.name));
  if (toAdd.length) {
    await confluenceApi('POST', `/rest/api/content/${contentId}/label`, toAdd);
  }
  for (const l of toRemove) {
    const qs = new URLSearchParams({ name: l.name, prefix: l.prefix });
    await confluenceApi(
      'DELETE',
      `/rest/api/content/${contentId}/label?${qs.toString()}`,
    );
  }
  return {
    contentId: String(contentId),
    prefix,
    added: toAdd.map((l) => l.name),
    removed: toRemove.map((l) => l.name),
    labels: await listContentLabels(contentId),
  };
}

/**
 * labels[] wins; else copy global labels from a page (if any);
 * else keep current template labels when keepLabels.
 */
async function resolveLabelsForTemplate({
  labels,
  copyLabelsFromContentId,
  keepLabels = true,
  currentLabels = [],
}) {
  if (Array.isArray(labels)) {
    return { labels: toLabelPayload(labels), source: 'explicit' };
  }
  if (copyLabelsFromContentId) {
    const fromPage = await listContentLabels(copyLabelsFromContentId, {
      prefix: 'global',
    });
    if (fromPage.length) return { labels: toLabelPayload(fromPage), source: 'page' };
  }
  if (keepLabels) {
    return { labels: toLabelPayload(currentLabels || []), source: 'template' };
  }
  return { labels: undefined, source: 'omit' };
}

async function putSpaceTemplate({
  current,
  spaceKey,
  name,
  description,
  storage,
  labels,
}) {
  if (typeof storage !== 'string' || !storage.trim()) {
    throw new Error(
      `No storage body for template ${current.templateId} (${current.name})`,
    );
  }
  const payload = {
    templateId: String(current.templateId),
    name: name || current.name,
    description: description ?? current.description ?? '',
    templateType: current.templateType || 'page',
    space: { key: spaceKey || current.space?.key },
    body: {
      storage: {
        value: storage,
        representation: 'storage',
      },
    },
  };
  if (labels !== undefined) {
    payload.labels = toLabelPayload(labels);
  }
  const updated = await confluenceApi('PUT', '/rest/experimental/template', payload);
  return { payload, updated };
}

async function setSpaceTemplateLabels({ spaceKey, templateId, name, labels }) {
  if (!Array.isArray(labels)) {
    throw new Error('labels array is required (pass [] to clear)');
  }
  const current = await findSpaceTemplate({
    spaceKey,
    templateId,
    name,
    expandBody: true,
  });
  const previous = toLabelPayload(current.labels || []);
  const { payload } = await putSpaceTemplate({
    current,
    spaceKey,
    storage: templateStorage(current),
    labels,
  });
  const after = await findSpaceTemplate({
    spaceKey,
    templateId: String(current.templateId),
    expandBody: false,
  });
  return {
    templateId: String(current.templateId),
    name: current.name,
    spaceKey: payload.space.key,
    previous: previous.map((l) => l.name),
    labels: (after.labels || payload.labels || []).map((l) => l.name || l),
    note: 'Create from template copies these labels onto the new page.',
  };
}

async function getPageMeta(contentId, expand = 'version,space,ancestors,body.storage') {
  return confluenceApi('GET', `/rest/api/content/${contentId}?expand=${expand}`);
}

async function listSpaceTemplates(spaceKey, { nameContains, expandBody = false, limit = 50 } = {}) {
  const results = [];
  let start = 0;
  const expand = expandBody ? 'body' : undefined;
  for (;;) {
    const qs = new URLSearchParams({
      spaceKey,
      limit: String(limit),
      start: String(start),
    });
    if (expand) qs.set('expand', expand);
    const data = await confluenceApi(
      'GET',
      `/rest/experimental/template/page?${qs.toString()}`,
    );
    const batch = data.results || [];
    for (const t of batch) {
      if (nameContains && !String(t.name).toLowerCase().includes(String(nameContains).toLowerCase())) {
        continue;
      }
      results.push(t);
    }
    const total = data.totalSize ?? start + batch.length;
    start += data.size ?? batch.length;
    if (!batch.length || start >= total) break;
    if (start > 1000) break;
  }
  return results;
}

async function findSpaceTemplate({ spaceKey, templateId, name, expandBody = false }) {
  if (!spaceKey) throw new Error('spaceKey is required (GET by id alone returns 404 on DC)');
  const all = await listSpaceTemplates(spaceKey, {
    nameContains: name,
    expandBody,
  });
  let hit;
  if (templateId) {
    hit = all.find((t) => String(t.templateId) === String(templateId));
  } else if (name) {
    hit = all.find((t) => t.name === name) || all.find((t) => t.name.includes(name));
  }
  if (!hit) {
    throw new Error(
      `Space template not found in ${spaceKey}` +
        (templateId ? ` id=${templateId}` : '') +
        (name ? ` name~${name}` : ''),
    );
  }
  if (expandBody && !templateStorage(hit)) {
    // list without expand then with expand+filter can miss; refetch with expand
    const withBody = await listSpaceTemplates(spaceKey, {
      nameContains: hit.name,
      expandBody: true,
    });
    hit = withBody.find((t) => String(t.templateId) === String(hit.templateId)) || hit;
  }
  return hit;
}

async function getSpaceTemplateToFile({ spaceKey, templateId, name, filePath }) {
  const t = await findSpaceTemplate({ spaceKey, templateId, name, expandBody: true });
  const storage = templateStorage(t);
  if (typeof storage !== 'string') {
    throw new Error(`No storage body for template ${t.templateId} (${t.name})`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, storage, 'utf8');
  return {
    ...summarizeTemplate(t, { includeBodyHash: true }),
    filePath,
    bytes: Buffer.byteLength(storage, 'utf8'),
  };
}

async function createSpaceTemplateFromFile({
  spaceKey,
  name,
  filePath,
  description = '',
  labels,
  copyLabelsFromContentId,
}) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const storage = readFileSync(filePath, 'utf8');
  if (!storage.trim()) throw new Error(`File is empty: ${filePath}`);

  const existing = await listSpaceTemplates(spaceKey, { nameContains: name });
  const clash = existing.find((t) => t.name === name);
  if (clash) {
    throw new Error(
      `Space template already exists in ${spaceKey}: id=${clash.templateId} name=${clash.name}`,
    );
  }

  const resolved = await resolveLabelsForTemplate({
    labels,
    copyLabelsFromContentId,
    keepLabels: false,
    currentLabels: [],
  });

  const payload = {
    name,
    description: description || '',
    templateType: 'page',
    space: { key: spaceKey },
    body: {
      storage: {
        value: storage,
        representation: 'storage',
      },
    },
  };
  if (resolved.labels?.length) {
    payload.labels = resolved.labels;
  }

  const created = await confluenceApi('POST', '/rest/experimental/template', payload);
  const createdStorage = templateStorage(created) || storage;
  return {
    templateId: String(created.templateId),
    name: created.name || name,
    spaceKey,
    description: created.description ?? description,
    labels: (created.labels || payload.labels || []).map((l) => l.name || l),
    bodyChars: storage.length,
    bodySha256: sha256(storage),
    matchedSha256: sha256(createdStorage) === sha256(storage),
    labelSource: resolved.source,
    note: payload.labels?.length
      ? 'Create from template copies these labels onto the new page.'
      : undefined,
  };
}

async function updateSpaceTemplateFromFile({
  spaceKey,
  templateId,
  name,
  filePath,
  description,
  keepLabels = true,
  labels,
  copyLabelsFromContentId,
}) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const storage = readFileSync(filePath, 'utf8');
  if (!storage.trim()) throw new Error(`File is empty: ${filePath}`);

  const current = await findSpaceTemplate({
    spaceKey,
    templateId,
    // When renaming, `name` is the *new* title — do not use it as list filter.
    name: templateId ? undefined : name,
    expandBody: false,
  });

  const resolved = await resolveLabelsForTemplate({
    labels,
    copyLabelsFromContentId,
    keepLabels,
    currentLabels: current.labels || [],
  });

  const { payload, updated } = await putSpaceTemplate({
    current,
    spaceKey,
    name,
    description: description ?? current.description ?? '',
    storage,
    labels: resolved.labels,
  });
  const updatedStorage = templateStorage(updated) || storage;
  return {
    templateId: String(current.templateId),
    name: payload.name,
    spaceKey: payload.space.key,
    description: payload.description,
    labels: payload.labels?.map((l) => l.name) || [],
    bodyChars: storage.length,
    bodySha256: sha256(storage),
    responseName: updated?.name,
    matchedSha256: sha256(updatedStorage) === sha256(storage),
    labelSource: resolved.source,
  };
}

/** Exact phrase the human must authorize in chat before the agent may pass confirm. */
const DELETE_CONFIRM_PHRASE = 'DELETE';

function assertDeleteConfirm(confirm) {
  if (confirm !== DELETE_CONFIRM_PHRASE) {
    throw new Error(
      `Refusing to delete: confirm must be the exact string "${DELETE_CONFIRM_PHRASE}" ` +
        '(destructive; no trash restore). Ask the human in chat first; do not invent confirmation.',
    );
  }
}

async function deleteSpaceTemplate({
  spaceKey,
  templateId,
  name,
  confirm,
  confirmName,
}) {
  assertDeleteConfirm(confirm);
  if (!templateId && !name) {
    throw new Error('Provide templateId and/or name');
  }
  if (typeof confirmName !== 'string' || !confirmName.trim()) {
    throw new Error(
      'Refusing to delete: confirmName is required and must exactly equal the template name ' +
        '(copy from listSpaceTemplates after the human approved deletion in chat).',
    );
  }

  const current = await findSpaceTemplate({
    spaceKey,
    templateId,
    name,
    expandBody: false,
  });
  if (current.name !== confirmName) {
    throw new Error(
      `Refusing to delete: confirmName "${confirmName}" does not exactly match template name "${current.name}" ` +
        `(id=${current.templateId}). Re-list and get human approval for the exact name.`,
    );
  }
  const id = String(current.templateId);

  // DC: DELETE /rest/experimental/template/{contentTemplateId} → 204 No Content
  await confluenceApi('DELETE', `/rest/experimental/template/${id}`);

  return {
    deleted: true,
    templateId: id,
    name: current.name,
    spaceKey: spaceKey || current.space?.key || null,
    description: current.description || '',
    labels: (current.labels || []).map((l) => l.name || l),
  };
}

async function deleteSpaceTemplates({ spaceKey, templateIds, confirm, confirmNames }) {
  assertDeleteConfirm(confirm);
  if (!Array.isArray(templateIds) || templateIds.length === 0) {
    throw new Error('Provide non-empty templateIds array');
  }
  if (!Array.isArray(confirmNames) || confirmNames.length !== templateIds.length) {
    throw new Error(
      'Refusing to delete: confirmNames must be an array of exact template names, ' +
        'same length and order as templateIds (after human approval in chat).',
    );
  }

  const results = [];
  for (let i = 0; i < templateIds.length; i++) {
    const tid = templateIds[i];
    try {
      results.push(
        await deleteSpaceTemplate({
          spaceKey,
          templateId: String(tid),
          confirm: DELETE_CONFIRM_PHRASE,
          confirmName: confirmNames[i],
        }),
      );
    } catch (error) {
      results.push({
        deleted: false,
        templateId: String(tid),
        spaceKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    spaceKey,
    requested: templateIds.length,
    deleted: results.filter((r) => r.deleted).length,
    failed: results.filter((r) => !r.deleted).length,
    results,
  };
}

async function syncPageToSpaceTemplate({
  contentId,
  spaceKey,
  templateId,
  name,
  description,
  descriptionSuffix,
  copyPageLabels = true,
  labels,
}) {
  const page = await getPageMeta(contentId, 'version,space,body.storage,title');
  const storage = page.body?.storage?.value;
  if (typeof storage !== 'string') {
    throw new Error(`No body.storage on page ${contentId}`);
  }

  const current = await findSpaceTemplate({
    spaceKey,
    templateId,
    name,
    expandBody: false,
  });

  let desc = description;
  if (desc === undefined) {
    desc = current.description || '';
    if (descriptionSuffix) {
      const base = desc.replace(/\s*\(синхрон с BSA[^)]*\)\s*$/u, '').trim();
      desc = `${base} ${descriptionSuffix}`.trim();
    }
  }

  const resolved = await resolveLabelsForTemplate({
    labels,
    copyLabelsFromContentId: copyPageLabels !== false ? contentId : undefined,
    keepLabels: true,
    currentLabels: current.labels || [],
  });

  const { payload, updated } = await putSpaceTemplate({
    current,
    spaceKey,
    description: desc,
    storage,
    labels: resolved.labels ?? toLabelPayload(current.labels || []),
  });
  const updatedStorage = templateStorage(updated) || storage;
  return {
    sourcePageId: String(contentId),
    sourceTitle: page.title,
    sourceVersion: page.version.number,
    templateId: String(current.templateId),
    templateName: current.name,
    spaceKey: payload.space.key,
    description: desc,
    labels: payload.labels?.map((l) => l.name) || [],
    labelSource: resolved.source,
    copiedPageLabels: resolved.source === 'page',
    bodyChars: storage.length,
    bodySha256: sha256(storage),
    matchedSha256: sha256(updatedStorage) === sha256(storage),
    note: 'Create from template copies these labels onto the new page.',
  };
}

async function movePage(contentId, parentId, versionComment) {
  const page = await getPageMeta(contentId, 'version,space,ancestors');
  const currentParent = page.ancestors?.[page.ancestors.length - 1]?.id;
  if (String(currentParent) === String(parentId)) {
    return {
      id: String(contentId),
      title: page.title,
      parentId: String(parentId),
      moved: false,
      reason: 'already under parent',
      version: page.version.number,
    };
  }

  const nextVersion = page.version.number + 1;
  const updated = await confluenceApi('PUT', `/rest/api/content/${contentId}`, {
    id: String(contentId),
    type: 'page',
    title: page.title,
    space: { key: page.space.key },
    version: {
      number: nextVersion,
      message: versionComment || `Moved under parent ${parentId}`,
    },
    ancestors: [{ id: String(parentId) }],
  });

  return {
    id: String(contentId),
    title: updated.title || page.title,
    parentId: String(parentId),
    moved: true,
    version: nextVersion,
    url: updated._links?.webui
      ? `${resolveHost()}${updated._links.webui}`
      : undefined,
  };
}

const REORDER_POSITIONS = new Set(['above', 'below', 'append']);

/**
 * DC 9.x has no public REST /content/{id}/move/... (Cloud-only).
 * Sibling reorder uses the same endpoint as Space tools → Reorder pages:
 * POST /pages/movepage.action?pageId=&targetId=&position=above|below|append
 */
async function movepageAction(contentId, targetId, position) {
  if (!REORDER_POSITIONS.has(position)) {
    throw new Error(`position must be one of: ${[...REORDER_POSITIONS].join(', ')}`);
  }
  const qs = new URLSearchParams({
    pageId: String(contentId),
    targetId: String(targetId),
    position,
  });
  const host = resolveHost();
  const token = resolveToken();
  const res = await fetch(`${host}/pages/movepage.action?${qs}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const msg =
      data?.errorMessage ||
      data?.message ||
      (Array.isArray(data?.actionErrors) ? data.actionErrors.join('; ') : null) ||
      text.slice(0, 500);
    throw new Error(`POST /pages/movepage.action → ${res.status}: ${msg}`);
  }
  if (Array.isArray(data?.actionErrors) && data.actionErrors.length) {
    throw new Error(`movepage.action: ${data.actionErrors.join('; ')}`);
  }
  const delegate = data?.commandDelegate;
  if (delegate && delegate.valid === false) {
    const errs = (delegate.validationErrors || [])
      .map((e) => e.message || e)
      .join('; ');
    throw new Error(`movepage.action invalid: ${errs || 'validation failed'}`);
  }
  if (delegate && delegate.authorized === false) {
    throw new Error('movepage.action: not authorized');
  }
  return data;
}

async function listChildPages(parentId, { limit = 200 } = {}) {
  const results = [];
  let start = 0;
  const pageLimit = Math.min(Number(limit) || 200, 200);
  for (;;) {
    const qs = new URLSearchParams({
      limit: String(pageLimit),
      start: String(start),
      expand: 'extensions.position',
    });
    const data = await confluenceApi(
      'GET',
      `/rest/api/content/${parentId}/child/page?${qs}`,
    );
    const batch = data.results || [];
    for (const c of batch) {
      const pos = c.extensions?.position;
      results.push({
        id: String(c.id),
        title: c.title,
        position: pos === 'none' || pos === undefined ? null : pos,
        status: c.status,
        tinyui: c._links?.tinyui,
        webui: c._links?.webui
          ? `${resolveHost()}${c._links.webui}`
          : undefined,
      });
    }
    start += data.size ?? batch.length;
    const total = data.totalSize ?? start;
    if (!batch.length || start >= total || results.length >= limit) break;
  }
  return results.slice(0, limit);
}

async function reorderPage({ contentId, targetId, position }) {
  if (String(contentId) === String(targetId) && position !== 'append') {
    throw new Error('contentId and targetId must differ for above/below');
  }
  const [page, target] = await Promise.all([
    getPageMeta(contentId, 'version,space,ancestors'),
    getPageMeta(targetId, 'version,space,ancestors'),
  ]);
  await movepageAction(contentId, targetId, position);
  const parentId =
    position === 'append'
      ? String(targetId)
      : target.ancestors?.[target.ancestors.length - 1]?.id;
  let children = [];
  if (parentId) {
    children = await listChildPages(parentId);
  }
  const index = children.findIndex((c) => c.id === String(contentId));
  return {
    id: String(contentId),
    title: page.title,
    targetId: String(targetId),
    targetTitle: target.title,
    position,
    parentId: parentId ? String(parentId) : undefined,
    index: index >= 0 ? index : undefined,
    siblings: children.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
    })),
  };
}

/**
 * Set exact sibling order under parentId by sequential movepage above/below.
 * childIds must list every direct child (same set as current children).
 */
async function setChildPageOrder({ parentId, childIds }) {
  const desired = childIds.map(String);
  if (new Set(desired).size !== desired.length) {
    throw new Error('childIds must be unique');
  }
  const current = await listChildPages(parentId);
  const currentIds = current.map((c) => c.id);
  const missing = desired.filter((id) => !currentIds.includes(id));
  const extra = currentIds.filter((id) => !desired.includes(id));
  if (missing.length || extra.length) {
    throw new Error(
      `childIds must be a permutation of current children under ${parentId}` +
        (missing.length ? `; not children: ${missing.join(',')}` : '') +
        (extra.length ? `; omitted: ${extra.join(',')}` : ''),
    );
  }
  if (currentIds.join(',') === desired.join(',')) {
    return {
      parentId: String(parentId),
      changed: false,
      reason: 'already in requested order',
      children: current,
    };
  }

  const steps = [];
  // Place first page above whatever is currently first (if needed).
  if (desired[0] !== currentIds[0]) {
    await movepageAction(desired[0], currentIds[0], 'above');
    steps.push({ contentId: desired[0], targetId: currentIds[0], position: 'above' });
  }
  for (let i = 1; i < desired.length; i++) {
    const after = await listChildPages(parentId);
    const afterIds = after.map((c) => c.id);
    if (afterIds[i] === desired[i] && afterIds[i - 1] === desired[i - 1]) {
      continue;
    }
    await movepageAction(desired[i], desired[i - 1], 'below');
    steps.push({
      contentId: desired[i],
      targetId: desired[i - 1],
      position: 'below',
    });
  }

  const children = await listChildPages(parentId);
  const okOrder = children.map((c) => c.id).join(',') === desired.join(',');
  if (!okOrder) {
    throw new Error(
      `setChildPageOrder incomplete: got [${children.map((c) => c.id).join(',')}] ` +
        `want [${desired.join(',')}]`,
    );
  }
  return {
    parentId: String(parentId),
    changed: steps.length > 0,
    steps,
    children,
  };
}

async function followTinyUrlAction(code) {
  const host = resolveHost();
  const token = resolveToken();
  const qs = new URLSearchParams({ urlIdentifier: code });
  const path = `/pages/tinyurl.action?${qs.toString()}`;
  const res = await fetch(`${host}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const contentId = parseContentIdFromLocation(res.url);
  if (contentId) return { contentId };
  const text = await res.text();
  const fromHtml = parseContentIdFromLocation(text);
  if (fromHtml) return { contentId: fromHtml };
  return null;
}

async function resolveTinyUrl(input) {
  const trimmed = String(input).trim();
  const { page, code, contentId, resolvedVia } = await resolveTinyUrlMeta(trimmed, {
    getPageById: (id) => getPageMeta(id, 'version,space'),
    followTinyUrl: followTinyUrlAction,
  });
  return {
    input: trimmed,
    code,
    id: String(page.id ?? contentId),
    title: page.title,
    type: page.type,
    status: page.status,
    version: page.version?.number,
    spaceKey: page.space?.key,
    tinyui: page._links?.tinyui ?? `/x/${code}`,
    resolvedVia,
    webui: page._links?.webui
      ? `${resolveHost()}${page._links.webui}`
      : undefined,
  };
}

/**
 * List page version metadata (no bodies). Newest-first as returned by DC.
 * Paginate with start/limit; optional maxResults caps how many rows to fetch.
 */
async function listVersions(contentId, { start = 0, limit = 50, maxResults } = {}) {
  const pageLimit = Math.min(
    200,
    Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 50),
  );
  let cursor = Math.max(0, Number.isFinite(Number(start)) ? Number(start) : 0);
  const versions = [];
  let totalSize;
  const hardCap =
    maxResults == null
      ? Infinity
      : Math.max(1, Number.isFinite(Number(maxResults)) ? Number(maxResults) : 1);

  while (versions.length < hardCap) {
    const batchLimit = Math.min(pageLimit, hardCap - versions.length);
    const data = await confluenceApi(
      'GET',
      buildVersionsListPath(contentId, { start: cursor, limit: batchLimit }),
    );
    const batch = data.results || [];
    if (data.totalSize != null) totalSize = data.totalSize;
    for (const v of batch) {
      versions.push(summarizeVersion(v));
      if (versions.length >= hardCap) break;
    }
    const size = data.size ?? batch.length;
    cursor += size;
    if (!batch.length || size === 0) break;
    if (data.totalSize != null && cursor >= data.totalSize) break;
    // No more pages when we got a short batch
    if (batch.length < batchLimit) break;
  }

  return {
    id: String(contentId),
    start: Math.max(0, Number(start) || 0),
    limit: pageLimit,
    count: versions.length,
    ...(totalSize != null ? { totalSize } : {}),
    versions,
    note:
      'Metadata only (no body). To inspect an old body: getStorageToFile with version=N, then storage_* on the file — do not dump XML into chat.',
  };
}

async function getStorageToFile(contentId, filePath, version) {
  let page;
  let historical = false;
  if (version == null) {
    page = await getPageMeta(contentId);
  } else {
    historical = true;
    page = await confluenceApi(
      'GET',
      buildHistoricalContentPath(contentId, version),
    );
  }
  const storage = page.body?.storage?.value;
  if (typeof storage !== 'string') {
    throw new Error(
      historical
        ? `No body.storage for content ${contentId} historical version ${version}`
        : `No body.storage for content ${contentId}`,
    );
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, storage, 'utf8');
  const ver = page.version || {};
  return {
    id: String(contentId),
    title: page.title,
    version: ver.number ?? version ?? null,
    historical,
    ...(historical
      ? {
          when: ver.when ?? null,
          message: ver.message ?? '',
          by: {
            username: ver.by?.username ?? '',
            displayName: ver.by?.displayName ?? '',
          },
        }
      : {}),
    spaceKey: page.space?.key,
    filePath,
    bytes: Buffer.byteLength(storage, 'utf8'),
    tinyui: page._links?.tinyui,
    webui: page._links?.webui
      ? `${resolveHost()}${page._links.webui}`
      : undefined,
  };
}

async function updateStorageFromFile({
  contentId,
  filePath,
  version,
  title,
  versionComment,
  parentId,
}) {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const storage = readFileSync(filePath, 'utf8');
  if (!storage.trim()) {
    throw new Error(`File is empty: ${filePath}`);
  }

  const page = await getPageMeta(contentId, 'version,space,title');
  const currentVersion = page.version.number;
  const nextVersion = version ?? currentVersion + 1;
  if (nextVersion !== currentVersion + 1) {
    throw new Error(
      `Version mismatch: page is at ${currentVersion}, refused to write ${nextVersion} (expected ${currentVersion + 1}). Re-dump and retry.`,
    );
  }

  const payload = {
    id: String(contentId),
    type: 'page',
    title: title || page.title,
    space: { key: page.space.key },
    version: {
      number: nextVersion,
      message: versionComment || 'Updated via confluence-dc-advops-mcp from file',
    },
    body: {
      storage: {
        value: storage,
        representation: 'storage',
      },
    },
  };
  if (parentId) {
    payload.ancestors = [{ id: String(parentId) }];
  }

  const updated = await confluenceApi('PUT', `/rest/api/content/${contentId}`, payload);
  return {
    id: String(contentId),
    title: updated.title || payload.title,
    version: nextVersion,
    previousVersion: currentVersion,
    filePath,
    bytes: Buffer.byteLength(storage, 'utf8'),
    webui: updated._links?.webui
      ? `${resolveHost()}${updated._links.webui}`
      : undefined,
  };
}

function summarizeAttachment(att) {
  const v = att.version || {};
  const links = att._links || {};
  return {
    id: String(att.id),
    title: att.title,
    mediaType: att.metadata?.mediaType || att.extensions?.mediaType,
    fileSize: att.extensions?.fileSize,
    comment: att.metadata?.comment,
    version: v.number,
    when: v.when,
    by: v.by?.displayName || v.by?.username,
    downloadPath: links.download,
    webui: links.webui,
  };
}

async function listAttachments(contentId, { filename, limit = 50 } = {}) {
  const results = [];
  let start = 0;
  for (;;) {
    const qs = new URLSearchParams({
      expand: 'version,container,metadata',
      limit: String(limit),
      start: String(start),
    });
    if (filename) qs.set('filename', filename);
    const data = await confluenceApi(
      'GET',
      `/rest/api/content/${contentId}/child/attachment?${qs.toString()}`,
    );
    const batch = data.results || [];
    results.push(...batch);
    const total = data.totalSize ?? start + batch.length;
    start += data.size ?? batch.length;
    if (!batch.length || start >= total) break;
    if (start > 500) break;
  }
  return results;
}

async function findAttachment({ contentId, attachmentId, filename }) {
  if (attachmentId) {
    const data = await confluenceApi(
      'GET',
      `/rest/api/content/${attachmentId}?expand=version,container,metadata,extensions`,
    );
    if (data.type !== 'attachment') {
      throw new Error(`Content ${attachmentId} is not an attachment (type=${data.type})`);
    }
    return data;
  }
  if (!filename) throw new Error('Provide attachmentId and/or filename');
  const list = await listAttachments(contentId, { filename });
  const hit =
    list.find((a) => a.title === filename) ||
    list.find((a) => String(a.title).toLowerCase() === String(filename).toLowerCase());
  if (!hit) {
    throw new Error(`Attachment not found on page ${contentId}: ${filename}`);
  }
  return hit;
}

async function downloadAttachmentToFile({ contentId, attachmentId, filename, filePath }) {
  const att = await findAttachment({ contentId, attachmentId, filename });
  const id = String(att.id);
  const pageId = contentId || att.container?.id || att.extensions?.containerId;
  if (!pageId) throw new Error(`Cannot resolve parent page for attachment ${id}`);

  // DC: /download/attachments/... works with Bearer; Cloud-style REST .../download often 404s.
  let res;
  const dl = att._links?.download;
  if (dl) {
    const path = dl.startsWith('http')
      ? `${new URL(dl).pathname}${new URL(dl).search}`
      : dl.startsWith('/')
        ? dl
        : `/${dl}`;
    res = await confluenceFetchRaw('GET', path);
  } else {
    res = await confluenceFetchRaw(
      'GET',
      `/rest/api/content/${pageId}/child/attachment/${id}/download`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return {
    ...summarizeAttachment(att),
    contentId: String(pageId),
    filePath,
    bytes: buf.length,
  };
}

async function uploadAttachmentFromFile({
  contentId,
  filePath,
  comment,
  minorEdit = true,
  filename,
}) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const name = filename || basename(filePath);
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  if (comment) form.append('comment', comment);
  form.append('minorEdit', String(Boolean(minorEdit)));

  const res = await confluenceFetchRaw(
    'POST',
    `/rest/api/content/${contentId}/child/attachment`,
    { body: form },
  );
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  const created = data?.results?.[0] || data;
  return {
    contentId: String(contentId),
    uploaded: summarizeAttachment(created),
    bytes: buf.length,
    filePath,
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text → storage XML. Blank lines split paragraphs; single newlines → <br />. */
function plainToCommentStorage(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) throw new Error('Comment body is empty');
  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const inner = escapeHtml(block).replace(/\n/g, '<br />');
      return `<p>${inner}</p>`;
    })
    .join('');
}

function resolveCommentStorage(body, bodyFormat = 'plain') {
  if (bodyFormat === 'storage') {
    const storage = String(body ?? '');
    if (!storage.trim()) throw new Error('Comment body is empty');
    return storage;
  }
  return plainToCommentStorage(body);
}

function storageToPlainHint(storage) {
  if (typeof storage !== 'string') return '';
  return storage
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeComment(c) {
  const storage = c.body?.storage?.value;
  const ancestors = c.ancestors || [];
  const parent = [...ancestors].reverse().find((a) => a.type === 'comment') || null;
  const by =
    c.version?.by?.displayName ||
    c.version?.by?.username ||
    c.history?.createdBy?.displayName ||
    c.history?.createdBy?.username;
  const loc = c.extensions?.location || 'footer';
  const resolution = c.extensions?.resolution || null;
  const inlineProps = c.extensions?.inlineProperties || null;
  const resolutionStatus = resolution?.status
    ? String(resolution.status).toLowerCase()
    : null;
  const isResolved =
    loc === 'resolved' || resolutionStatus === 'resolved';
  return {
    id: String(c.id),
    parentCommentId: parent ? String(parent.id) : null,
    containerId: c.container?.id != null ? String(c.container.id) : undefined,
    location: loc,
    status: isResolved ? 'resolved' : 'open',
    visibleOnPage: loc === 'inline' && !isResolved,
    originalSelection:
      inlineProps?.originalSelection ||
      inlineProps?.textSelection ||
      null,
    markerRef: inlineProps?.markerRef != null ? String(inlineProps.markerRef) : null,
    resolution: resolution
      ? {
          status: resolution.status,
          lastModifier:
            resolution.lastModifier?.displayName ||
            resolution.lastModifier?.username ||
            null,
        }
      : undefined,
    bodyStorage: storage,
    bodyText: storageToPlainHint(storage),
    version: c.version?.number,
    when: c.version?.when || c.history?.createdDate,
    by,
    title: c.title,
  };
}

async function listPageComments(
  contentId,
  { depth = 'all', limit = 50, locations = ['footer'] } = {},
) {
  const locs = Array.isArray(locations) && locations.length ? locations : ['footer'];
  const results = [];
  let start = 0;
  const pageLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  for (;;) {
    const qs = new URLSearchParams({
      expand:
        'body.storage,version,history,ancestors,container,extensions.inlineProperties,extensions.resolution',
      limit: String(pageLimit),
      start: String(start),
    });
    for (const loc of locs) qs.append('location', loc);
    if (depth === 'all') qs.set('depth', 'all');
    const data = await confluenceApi(
      'GET',
      `/rest/api/content/${contentId}/child/comment?${qs.toString()}`,
    );
    const batch = asResults(data);
    results.push(...batch);
    const total = data.totalSize ?? start + batch.length;
    start += data.size ?? batch.length;
    if (!batch.length || start >= total) break;
    if (start > 2000) break;
  }
  return results.map(summarizeComment);
}

async function getComment(commentId) {
  return confluenceApi(
    'GET',
    `/rest/api/content/${commentId}?expand=body.storage,version,history,ancestors,container,extensions.inlineProperties,extensions.resolution`,
  );
}

async function addPageComment({
  contentId,
  body,
  bodyFormat = 'plain',
  parentCommentId,
  location,
}) {
  const storage = resolveCommentStorage(body, bodyFormat);
  const payload = {
    type: 'comment',
    container: { id: String(contentId), type: 'page' },
    body: {
      storage: {
        value: storage,
        representation: 'storage',
      },
    },
  };
  if (parentCommentId) {
    payload.ancestors = [{ id: String(parentCommentId) }];
  }
  if (location === 'inline') {
    // Reply in an inline thread — do not create a new text anchor.
    payload.extensions = { location: 'inline' };
  }
  const created = await confluenceApi(
    'POST',
    '/rest/api/content?expand=body.storage,version,history,ancestors,container,extensions.inlineProperties,extensions.resolution',
    payload,
  );
  return {
    contentId: String(contentId),
    parentCommentId: parentCommentId ? String(parentCommentId) : null,
    comment: summarizeComment(created),
  };
}

async function replyToInlineComment({
  contentId,
  parentCommentId,
  body,
  bodyFormat = 'plain',
}) {
  const parent = await getComment(parentCommentId);
  const loc = parent.extensions?.location;
  if (loc !== 'inline' && loc !== 'resolved') {
    throw new Error(
      `Parent ${parentCommentId} is not an inline comment (location=${loc || 'none'}). ` +
        'Use confluence_replyToComment for footer threads.',
    );
  }
  const pageId =
    contentId ||
    (parent.container?.type === 'page' ? parent.container.id : null);
  if (!pageId) {
    throw new Error(`Could not resolve page id for inline comment ${parentCommentId}`);
  }
  return addPageComment({
    contentId: String(pageId),
    body,
    bodyFormat,
    parentCommentId,
    location: 'inline',
  });
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'confluence-dc-advops-mcp',
  version: '1.9.8',
});

server.tool(
  'confluence_listAttachments',
  'List attachments on a Confluence page (GET /rest/api/content/{id}/child/attachment). Optional exact filename filter.',
  {
    contentId: z.string().describe('Parent page ID'),
    filename: z.string().optional().describe('Exact filename filter, e.g. onbording.zip'),
  },
  async ({ contentId, filename }) => {
    try {
      const list = await listAttachments(contentId, { filename });
      return ok({
        contentId,
        count: list.length,
        attachments: list.map(summarizeAttachment),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_downloadAttachmentToFile',
  'Download a page attachment binary to a local file. Identify by attachmentId and/or filename on contentId. Prefer this over stuffing binaries into chat.',
  {
    contentId: z.string().describe('Parent page ID'),
    attachmentId: z.string().optional().describe('Attachment content ID'),
    filename: z.string().optional().describe('Attachment title/filename, e.g. onbording.zip'),
    filePath: z.string().describe('Absolute local path to write the file'),
  },
  async (args) => {
    try {
      if (!args.attachmentId && !args.filename) {
        throw new Error('Provide attachmentId and/or filename');
      }
      return ok(await downloadAttachmentToFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_uploadAttachmentFromFile',
  'Upload (or add a new version of) a local file as a page attachment via multipart POST /rest/api/content/{id}/child/attachment. Sets X-Atlassian-Token: no-check.',
  {
    contentId: z.string().describe('Parent page ID'),
    filePath: z.string().describe('Absolute path to the local file to upload'),
    filename: z
      .string()
      .optional()
      .describe('Override attachment title (default: basename of filePath)'),
    comment: z.string().optional().describe('Attachment comment'),
    minorEdit: z
      .boolean()
      .optional()
      .describe('minorEdit flag (default true)'),
  },
  async (args) => {
    try {
      return ok(await uploadAttachmentFromFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_listComments',
  'List footer (page) comments on a Confluence page. GET /rest/api/content/{id}/child/comment?location=footer. Inline comments are not included — put document quotes in the comment body instead.',
  {
    contentId: z.string().describe('Page ID'),
    depth: z
      .enum(['root', 'all'])
      .optional()
      .describe('root = top-level only; all = include replies (default all)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Page size per request (default 50)'),
  },
  async ({ contentId, depth, limit }) => {
    try {
      const comments = await listPageComments(contentId, {
        depth: depth === 'root' ? 'root' : 'all',
        limit,
      });
      return ok({
        contentId: String(contentId),
        location: 'footer',
        count: comments.length,
        comments,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_addComment',
  'Add a footer comment under a page (POST /rest/api/content type=comment). Not inline — quote the relevant page text in the body if needed. bodyFormat plain (default) wraps text in <p>; storage passes Confluence storage XML as-is.',
  {
    contentId: z.string().describe('Page ID'),
    body: z
      .string()
      .describe(
        'Comment text. Plain: use blank lines for paragraphs. Tip: start with a quote from the page so the subject is clear.',
      ),
    bodyFormat: z
      .enum(['plain', 'storage'])
      .optional()
      .describe('plain (default) or storage XML'),
  },
  async ({ contentId, body, bodyFormat }) => {
    try {
      return ok(
        await addPageComment({
          contentId,
          body,
          bodyFormat: bodyFormat || 'plain',
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_replyToComment',
  'Reply in a footer comment thread (POST comment with ancestors = parent). Same bodyFormat as addComment.',
  {
    contentId: z.string().describe('Page ID (container of the thread)'),
    parentCommentId: z.string().describe('Parent footer comment ID'),
    body: z.string().describe('Reply text (plain or storage per bodyFormat)'),
    bodyFormat: z
      .enum(['plain', 'storage'])
      .optional()
      .describe('plain (default) or storage XML'),
  },
  async ({ contentId, parentCommentId, body, bodyFormat }) => {
    try {
      return ok(
        await addPageComment({
          contentId,
          body,
          bodyFormat: bodyFormat || 'plain',
          parentCommentId,
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_listInlineComments',
  'List inline comments on a page (read-only listing). Distinguishes open (visible on page, location=inline) vs resolved (location=resolved). Does not create new inline anchors.',
  {
    contentId: z.string().describe('Page ID'),
    status: z
      .enum(['open', 'resolved', 'all'])
      .optional()
      .describe(
        'open = visible on page; resolved = in Resolved; all = both (default all)',
      ),
    depth: z
      .enum(['root', 'all'])
      .optional()
      .describe('root = top-level only; all = include replies (default all)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Page size per request (default 50)'),
  },
  async ({ contentId, status, depth, limit }) => {
    try {
      const st = status || 'all';
      const locations =
        st === 'open'
          ? ['inline']
          : st === 'resolved'
            ? ['resolved']
            : ['inline', 'resolved'];
      const comments = await listPageComments(contentId, {
        depth: depth === 'root' ? 'root' : 'all',
        limit,
        locations,
      });
      return ok({
        contentId: String(contentId),
        statusFilter: st,
        count: comments.length,
        open: comments.filter((c) => c.status === 'open').length,
        resolved: comments.filter((c) => c.status === 'resolved').length,
        comments,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_replyToInlineComment',
  'Reply in an existing inline comment thread (open or resolved). Does not create a new text selection / anchor. bodyFormat plain|storage like footer comments.',
  {
    contentId: z
      .string()
      .optional()
      .describe('Page ID (optional if resolvable from parent comment container)'),
    parentCommentId: z.string().describe('Parent inline comment ID'),
    body: z.string().describe('Reply text'),
    bodyFormat: z
      .enum(['plain', 'storage'])
      .optional()
      .describe('plain (default) or storage XML'),
  },
  async ({ contentId, parentCommentId, body, bodyFormat }) => {
    try {
      return ok(
        await replyToInlineComment({
          contentId,
          parentCommentId,
          body,
          bodyFormat: bodyFormat || 'plain',
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_movePage',
  'Move (reparent) a Confluence Data Center page under a new parent. Uses PUT /rest/api/content/{id} with ancestors. Does not change page body.',
  {
    contentId: z.string().describe('ID of the page to move'),
    parentId: z.string().describe('ID of the new parent page'),
    versionComment: z
      .string()
      .optional()
      .describe('Optional Confluence version comment for the move'),
  },
  async ({ contentId, parentId, versionComment }) => {
    try {
      return ok(await movePage(contentId, parentId, versionComment));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_movePages',
  'Move several Confluence pages under new parents, sequentially. Each item reports success/error.',
  {
    moves: z
      .array(
        z.object({
          contentId: z.string().describe('ID of the page to move'),
          parentId: z.string().describe('ID of the new parent page'),
        }),
      )
      .min(1)
      .describe('List of move operations'),
    versionComment: z
      .string()
      .optional()
      .describe('Optional version comment applied to each successful move'),
  },
  async ({ moves, versionComment }) => {
    const results = [];
    for (const { contentId, parentId } of moves) {
      try {
        results.push({
          ok: true,
          ...(await movePage(contentId, parentId, versionComment)),
        });
      } catch (error) {
        results.push({
          ok: false,
          contentId,
          parentId,
          error: String(error?.message || error),
        });
      }
    }
    return ok({
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  },
);

server.tool(
  'confluence_listChildPages',
  'List direct child pages of a parent with tree position (GET /rest/api/content/{id}/child/page?expand=extensions.position). Use before/after reorder.',
  {
    parentId: z.string().describe('Parent page ID'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Max children to return (default 200)'),
  },
  async ({ parentId, limit }) => {
    try {
      const children = await listChildPages(parentId, { limit });
      return ok({
        parentId: String(parentId),
        count: children.length,
        children,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_reorderPage',
  'Change page order among siblings (or append under target). DC 9.x: POST /pages/movepage.action with position above|below|append. Prefer listChildPages first. above/below = same parent as target; append = become child of target.',
  {
    contentId: z.string().describe('Page ID to move in the tree'),
    targetId: z.string().describe('Reference page ID'),
    position: z
      .enum(['above', 'below', 'append'])
      .describe(
        'above/below = sibling of target; append = child of target (reparent+last)',
      ),
  },
  async (args) => {
    try {
      return ok(await reorderPage(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_setChildPageOrder',
  'Set exact order of all direct children under a parent. childIds must be a full permutation of current children. Uses sequential movepage above/below (DC has no bulk REST). Prefer listChildPages first; ask human before large reorder.',
  {
    parentId: z.string().describe('Parent page whose children to reorder'),
    childIds: z
      .array(z.string())
      .min(1)
      .describe('Desired child page IDs from first to last (full set)'),
  },
  async (args) => {
    try {
      return ok(await setChildPageOrder(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_resolveTinyUrl',
  'Resolve a Confluence tiny link (/x/{code} or bare code) to page id, title, space, version. Decodes with the DC alphabet (-→/, _→+; not RFC4648 base64url), GET /content/{id}; on 404 retries -↔_ swap, then tinyurl.action. Returns resolvedVia (decode | decode-swapped | tinyurl-action). Use before getContent / getStorageToFile when the user pasted a short URL.',
  {
    url: z
      .string()
      .min(1)
      .describe(
        'Full tiny URL (https://…/x/nf16Dw), path (/x/nf16Dw), bare code (nf16Dw), or tinyurl.action?urlIdentifier=…',
      ),
  },
  async ({ url }) => {
    try {
      return ok(await resolveTinyUrl(url));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_listVersions',
  'List Confluence page version metadata (number, when, message, author). No bodies — use before getStorageToFile(version=N) when asking who changed what. Newest-first. Paginate with start/limit; maxResults caps total rows fetched.',
  {
    contentId: z.string().describe('Confluence page ID'),
    start: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pagination offset (default 0)'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page size per API call (default 50, max 200)'),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Stop after this many version rows (across pages)'),
  },
  async ({ contentId, start, limit, maxResults }) => {
    try {
      return ok(await listVersions(contentId, { start, limit, maxResults }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_getStorageToFile',
  'Download Confluence page body.storage XML to a local file. Omit version for current; pass version=N for a historical snapshot (status=historical). Returns version/title/path (+ author when historical). Prefer this over stuffing huge storage into chat; then use storage_* on the file.',
  {
    contentId: z.string().describe('Confluence page ID'),
    filePath: z
      .string()
      .describe('Absolute path to write storage XML (e.g. /path/to/page.xml)'),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Historical version number from listVersions. Omit for the current published version.',
      ),
  },
  async ({ contentId, filePath, version }) => {
    try {
      return ok(await getStorageToFile(contentId, filePath, version));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_updateStorageFromFile',
  'Publish page body from a local storage XML file via the Confluence proxy (same auth as confluence-dc). Auto-increments version unless you pass version (= current+1). Pass content as-is — do not re-escape entities. Optional parentId to reparent in the same PUT.',
  {
    contentId: z.string().describe('Confluence page ID'),
    filePath: z.string().describe('Absolute path to storage XML file'),
    version: z
      .number()
      .optional()
      .describe('New version number; must be current+1. Omit to auto-bump.'),
    title: z.string().optional().describe('New title (default: keep current)'),
    versionComment: z.string().optional().describe('Confluence version comment'),
    parentId: z
      .string()
      .optional()
      .describe('Optional new parent page ID (reparent + body update)'),
  },
  async (args) => {
    try {
      return ok(await updateStorageFromFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_storage_listHeadings',
  'List h1–h6 headings in a local Confluence storage XML file (order, level, visible text). Does not return section bodies or full XML. Run after getStorageToFile.',
  {
    filePath: z.string().describe('Absolute path to dumped storage XML'),
  },
  async ({ filePath }) => {
    try {
      return ok(storageListHeadings(filePath));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_storage_getSection',
  'Read one section from a local storage XML file (heading until next same-or-higher heading). Default format=text. Does not return the whole page. Ambiguous heading → error + candidates. format=text/markdown inlines expand macro bodies (e.g. KTalk transcripts).',
  {
    filePath: z.string().describe('Absolute path to dumped storage XML'),
    heading: z.string().optional().describe('Exact heading text from listHeadings (whitespace-normalized)'),
    headingIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Index from listHeadings when heading text is ambiguous'),
    includeHeading: z
      .boolean()
      .optional()
      .describe('Include the heading node (default true)'),
    format: z
      .enum(['text', 'markdown', 'storage'])
      .optional()
      .describe('text (default), markdown (lossy), or storage fragment'),
    maxChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional cap on returned body. Omit to return the full section.'),
  },
  async (args) => {
    try {
      return ok(storageGetSection(args.filePath, args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_storage_replaceSection',
  'Replace the body of one section in a local storage XML file (heading kept). Does not publish. Markdown default; storage fragment allowed. Does not convert mermaid/layout/Jira. Ambiguous heading → error, file unchanged.',
  {
    filePath: z.string().describe('Absolute path to dumped storage XML'),
    heading: z.string().optional().describe('Exact heading text from listHeadings'),
    headingIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Index from listHeadings when heading is ambiguous'),
    body: z.string().describe('New section body only (not the whole page)'),
    bodyFormat: z
      .enum(['markdown', 'storage'])
      .optional()
      .describe('markdown (default) or storage XML fragment'),
    dryRun: z.boolean().optional().describe('Compute diff without writing the file'),
    replaceHeading: z
      .boolean()
      .optional()
      .describe('Also replace the heading text (default false)'),
    newHeading: z.string().optional().describe('New heading text when replaceHeading is true'),
  },
  async (args) => {
    try {
      return ok(storageReplaceSection(args.filePath, args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_storage_listMacros',
  'Inventory ac:structured-macro / ac:macro in a local storage XML file. Returns names, ids, params, parentHeading, bodyKind — not macro bodies.',
  {
    filePath: z.string().describe('Absolute path to dumped storage XML'),
    name: z.string().optional().describe('Filter by macro name, e.g. mermaid-macro'),
  },
  async ({ filePath, name }) => {
    try {
      return ok(storageListMacros(filePath, { name }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_storage_replaceMacroBody',
  'Replace the body of one macro in a local storage XML file. Wrapper and parameters unchanged. Selector: exactly one of macroId, name+parentHeading, or name+index. plain body goes in CDATA (no HTML-escape of -->). Does not publish.',
  {
    filePath: z.string().describe('Absolute path to dumped storage XML'),
    macroId: z.string().optional().describe('ac:macro-id'),
    name: z.string().optional().describe('Macro name, e.g. mermaid-macro'),
    parentHeading: z
      .string()
      .nullable()
      .optional()
      .describe('Nearest preceding heading text (with name)'),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Index from listMacros (with name)'),
    body: z.string().describe('New macro body'),
    bodyKind: z
      .enum(['plain', 'rich'])
      .optional()
      .describe('plain (default, CDATA) or rich (inner storage)'),
    dryRun: z.boolean().optional().describe('Compute without writing the file'),
  },
  async (args) => {
    try {
      return ok(storageReplaceMacroBody(args.filePath, args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_listLabels',
  'List labels on a Confluence page (GET /rest/api/content/{id}/label). Optional prefix filter (global|my).',
  {
    contentId: z.string().describe('Page ID'),
    prefix: z
      .enum(['global', 'my'])
      .optional()
      .describe('Filter by label prefix (default: all)'),
  },
  async ({ contentId, prefix }) => {
    try {
      const labels = await listContentLabels(contentId, { prefix });
      return ok({
        contentId: String(contentId),
        count: labels.length,
        labels,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_addLabels',
  'Add labels to a page (POST /rest/api/content/{id}/label). Does not remove existing labels. Global prefix.',
  {
    contentId: z.string().describe('Page ID'),
    labels: z
      .array(z.string())
      .min(1)
      .describe('Label names to add, e.g. ["draft"]'),
  },
  async ({ contentId, labels }) => {
    try {
      return ok(await addContentLabels(contentId, labels));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_removeLabels',
  'Remove labels from a page (DELETE /rest/api/content/{id}/label?name=). Continues on per-label errors.',
  {
    contentId: z.string().describe('Page ID'),
    labels: z
      .array(z.string())
      .min(1)
      .describe('Label names to remove'),
  },
  async ({ contentId, labels }) => {
    try {
      return ok(await removeContentLabels(contentId, labels));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_setLabels',
  'Replace global labels on a page (add missing, remove extras). Leaves personal (my) labels untouched.',
  {
    contentId: z.string().describe('Page ID'),
    labels: z
      .array(z.string())
      .describe('Desired global label names (empty array clears global labels)'),
  },
  async ({ contentId, labels }) => {
    try {
      return ok(await setContentLabels(contentId, labels));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_listSpaceTemplates',
  'List space page templates via /rest/experimental/template/page (DC). spaceKey required. Optional nameContains filter. Does not expand body by default (fast).',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    nameContains: z.string().optional().describe('Case-insensitive substring filter on template name'),
    expandBody: z
      .boolean()
      .optional()
      .describe('If true, expand body (slow). Default false.'),
  },
  async ({ spaceKey, nameContains, expandBody }) => {
    try {
      const list = await listSpaceTemplates(spaceKey, {
        nameContains,
        expandBody: Boolean(expandBody),
      });
      return ok({
        spaceKey,
        count: list.length,
        templates: list.map((t) => summarizeTemplate(t, { includeBodyHash: Boolean(expandBody) })),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_getSpaceTemplateToFile',
  'Download a space page template body.storage to a local XML file. Requires spaceKey (GET by id alone 404s on DC). Identify by templateId and/or exact/partial name.',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    templateId: z.string().optional().describe('Space template ID'),
    name: z.string().optional().describe('Template name or substring, e.g. CR-XXX-BRD'),
    filePath: z.string().describe('Absolute path to write storage XML'),
  },
  async (args) => {
    try {
      if (!args.templateId && !args.name) {
        throw new Error('Provide templateId and/or name');
      }
      return ok(await getSpaceTemplateToFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_createSpaceTemplateFromFile',
  'Create a new space page template from a local storage XML file via POST /rest/experimental/template. Fails if a template with the same name already exists.',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    name: z.string().describe('New template name, e.g. SRS-XXX-DB-01 Модель данных'),
    filePath: z.string().describe('Absolute path to storage XML (usually dumped from source page)'),
    description: z.string().optional().describe('Template description shown in Create from template'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Label names on the template (copied onto pages created from it)'),
    copyLabelsFromContentId: z
      .string()
      .optional()
      .describe('Copy global labels from this page onto the new template (ignored if labels is set)'),
  },
  async (args) => {
    try {
      return ok(await createSpaceTemplateFromFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_updateSpaceTemplateFromFile',
  'Update a space page template body from a local storage XML file via PUT /rest/experimental/template. Preserves labels by default. Source page remains SoT — this publishes a snapshot for Create from template. To rename: pass templateId + new `name` (id alone is used for lookup).',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    templateId: z.string().optional().describe('Space template ID'),
    name: z.string().optional().describe('Template name (used to find and/or rename)'),
    filePath: z.string().describe('Absolute path to storage XML'),
    description: z.string().optional().describe('New description; default keep current'),
    keepLabels: z.boolean().optional().describe('Keep existing labels (default true)'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Replace template labels with these names (wins over keepLabels / copy)'),
    copyLabelsFromContentId: z
      .string()
      .optional()
      .describe('Copy global labels from this page onto the template'),
  },
  async (args) => {
    try {
      if (!args.templateId && !args.name) {
        throw new Error('Provide templateId and/or name');
      }
      return ok(await updateSpaceTemplateFromFile(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_syncPageToSpaceTemplate',
  'Fast path: copy page body.storage (and by default global labels) into a space template. Create from template then stamps those labels on the new page.',
  {
    contentId: z.string().describe('Source page ID'),
    spaceKey: z.string().describe('Target space key'),
    templateId: z.string().optional().describe('Target space template ID'),
    name: z.string().optional().describe('Target template name if id unknown'),
    description: z.string().optional().describe('Replace template description entirely'),
    descriptionSuffix: z
      .string()
      .optional()
      .describe('Append/replace trailing sync note in template description'),
    copyPageLabels: z
      .boolean()
      .optional()
      .describe('Copy global labels from the source page onto the template (default true). If the page has none, keep current template labels.'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Explicit template labels (wins over copyPageLabels)'),
  },
  async (args) => {
    try {
      if (!args.templateId && !args.name) {
        throw new Error('Provide templateId and/or name');
      }
      return ok(await syncPageToSpaceTemplate(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_setSpaceTemplateLabels',
  'Set labels on a space template (PUT, body unchanged). Create from template copies these onto the new page. Pass [] to clear.',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    templateId: z.string().optional().describe('Space template ID'),
    name: z.string().optional().describe('Template name or substring if id unknown'),
    labels: z
      .array(z.string())
      .describe('Desired label names (empty array clears template labels)'),
  },
  async (args) => {
    try {
      if (!args.templateId && !args.name) {
        throw new Error('Provide templateId and/or name');
      }
      return ok(await setSpaceTemplateLabels(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_deleteSpaceTemplate',
  'DESTRUCTIVE. Delete one space Create template (DELETE /rest/experimental/template/{id}). ALWAYS stop and get explicit human approval in chat first — never invent confirm. Requires confirm="DELETE" and confirmName=exact template name. No trash restore; archive dump first.',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    templateId: z.string().optional().describe('Space template ID to delete'),
    name: z.string().optional().describe('Template name or substring if id unknown'),
    confirm: z
      .literal('DELETE')
      .describe('Pass only after human approved in this chat. Exact string DELETE (not true/yes).'),
    confirmName: z
      .string()
      .describe('Exact template name from listSpaceTemplates; must match the resolved template or delete is refused'),
  },
  {
    title: 'Delete space template (needs human confirm)',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  async (args) => {
    try {
      return ok(await deleteSpaceTemplate(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_deleteSpaceTemplates',
  'DESTRUCTIVE. Delete several space Create templates by id. ALWAYS get explicit human approval in chat first. Requires confirm="DELETE" and confirmNames[] exact names (same order as templateIds). Continues on per-item errors. Archive dump first.',
  {
    spaceKey: z.string().describe('Space key, e.g. MYSPACE'),
    templateIds: z
      .array(z.string())
      .min(1)
      .describe('Template IDs to delete, e.g. ["104005670","110428188"]'),
    confirm: z
      .literal('DELETE')
      .describe('Pass only after human approved in this chat. Exact string DELETE (not true/yes).'),
    confirmNames: z
      .array(z.string())
      .min(1)
      .describe('Exact template names, same length/order as templateIds'),
  },
  {
    title: 'Delete space templates batch (needs human confirm)',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  async (args) => {
    try {
      return ok(await deleteSpaceTemplates(args));
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
