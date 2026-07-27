#!/usr/bin/env node
/**
 * Local Confluence DC helpers for Cursor:
 * - move/reparent pages (until upstream parentId lands)
 * - dump/update page storage from/to a local file (large templates without stuffing XML into chat)
 * - list / dump / update space page templates (TempStream Create from template)
 * - sync BSA page → space template in one call
 *
 * Auth/host: same as @atlassian-dc-mcp/confluence (proxy localhost:8443 + keychain token).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  labels = [],
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
  if (labels.length) {
    payload.labels = labels.map((l) =>
      typeof l === 'string' ? { prefix: 'global', name: l } : { prefix: l.prefix || 'global', name: l.name },
    );
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
  };
}

async function updateSpaceTemplateFromFile({
  spaceKey,
  templateId,
  name,
  filePath,
  description,
  keepLabels = true,
}) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const storage = readFileSync(filePath, 'utf8');
  if (!storage.trim()) throw new Error(`File is empty: ${filePath}`);

  const current = await findSpaceTemplate({
    spaceKey,
    templateId,
    name,
    expandBody: false,
  });

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
  if (keepLabels && current.labels?.length) {
    payload.labels = current.labels.map((l) => ({
      prefix: l.prefix || 'global',
      name: l.name,
    }));
  }

  const updated = await confluenceApi('PUT', '/rest/experimental/template', payload);
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
  };
}

async function syncPageToSpaceTemplate({
  contentId,
  spaceKey,
  templateId,
  name,
  description,
  descriptionSuffix,
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

  const payload = {
    templateId: String(current.templateId),
    name: current.name,
    description: desc,
    templateType: current.templateType || 'page',
    space: { key: spaceKey || current.space?.key },
    labels: (current.labels || []).map((l) => ({
      prefix: l.prefix || 'global',
      name: l.name,
    })),
    body: {
      storage: {
        value: storage,
        representation: 'storage',
      },
    },
  };

  const updated = await confluenceApi('PUT', '/rest/experimental/template', payload);
  const updatedStorage = templateStorage(updated) || storage;
  return {
    sourcePageId: String(contentId),
    sourceTitle: page.title,
    sourceVersion: page.version.number,
    templateId: String(current.templateId),
    templateName: current.name,
    spaceKey: payload.space.key,
    description: desc,
    bodyChars: storage.length,
    bodySha256: sha256(storage),
    matchedSha256: sha256(updatedStorage) === sha256(storage),
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

async function getStorageToFile(contentId, filePath) {
  const page = await getPageMeta(contentId);
  const storage = page.body?.storage?.value;
  if (typeof storage !== 'string') {
    throw new Error(`No body.storage for content ${contentId}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, storage, 'utf8');
  return {
    id: String(contentId),
    title: page.title,
    version: page.version.number,
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
  version: '1.2.1',
});

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
  'confluence_getStorageToFile',
  'Download Confluence page body.storage XML to a local file for surgical edits (large templates). Returns version/title/path. Prefer this over stuffing huge storage into chat.',
  {
    contentId: z.string().describe('Confluence page ID'),
    filePath: z
      .string()
      .describe('Absolute path to write storage XML (e.g. /Users/.../Betcity/_tmp_brd.xml)'),
  },
  async ({ contentId, filePath }) => {
    try {
      return ok(await getStorageToFile(contentId, filePath));
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
  'confluence_listSpaceTemplates',
  'List space page templates via /rest/experimental/template/page (DC). Use spaceKey=TempStream for ДРП Create from template. Optional nameContains filter. Does not expand body by default (fast).',
  {
    spaceKey: z.string().describe('Space key, e.g. TempStream'),
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
    spaceKey: z.string().describe('Space key, e.g. TempStream'),
    templateId: z.string().optional().describe('Space template ID, e.g. 227016711 for CR-XXX-BRD'),
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
  'Create a new space page template from a local storage XML file via POST /rest/experimental/template. Use after a new BSA заготовка exists and needs a TempStream Create-from-template entry. Fails if a template with the same name already exists.',
  {
    spaceKey: z.string().describe('Space key, e.g. TempStream'),
    name: z.string().describe('New template name, e.g. SRS-XXX-DB-01 Модель данных'),
    filePath: z.string().describe('Absolute path to storage XML (usually dumped from BSA page)'),
    description: z.string().optional().describe('Template description shown in Create from template'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Optional label names (global prefix)'),
  },
  async (args) => {
    try {
      return ok(
        await createSpaceTemplateFromFile({
          ...args,
          labels: args.labels || [],
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'confluence_updateSpaceTemplateFromFile',
  'Update a space page template body from a local storage XML file via PUT /rest/experimental/template. Preserves labels by default. BSA page remains source of truth — this publishes a snapshot for Create from template.',
  {
    spaceKey: z.string().describe('Space key, e.g. TempStream'),
    templateId: z.string().optional().describe('Space template ID'),
    name: z.string().optional().describe('Template name (used to find and/or rename)'),
    filePath: z.string().describe('Absolute path to storage XML'),
    description: z.string().optional().describe('New description; default keep current'),
    keepLabels: z.boolean().optional().describe('Keep existing labels (default true)'),
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
  'Fast path: copy body.storage from a BSA/page contentId into a TempStream space template (Create from template snapshot). Example: contentId=259706536 (Заготовка BRD) → templateId=227016711 (CR-XXX-BRD) spaceKey=TempStream.',
  {
    contentId: z.string().describe('Source page ID (BSA заготовка)'),
    spaceKey: z.string().describe('Target space key, usually TempStream'),
    templateId: z.string().optional().describe('Target space template ID'),
    name: z.string().optional().describe('Target template name if id unknown'),
    description: z.string().optional().describe('Replace template description entirely'),
    descriptionSuffix: z
      .string()
      .optional()
      .describe('Append/replace trailing sync note, e.g. "(синхрон с BSA 2.25: хаб + дети US)"'),
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

const transport = new StdioServerTransport();
await server.connect(transport);
