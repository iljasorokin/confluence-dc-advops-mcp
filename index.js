#!/usr/bin/env node
/**
 * Local Confluence DC helpers for Cursor:
 * - move/reparent pages (until upstream parentId lands)
 * - dump/update page storage from/to a local file (large templates without stuffing XML into chat)
 *
 * Auth/host: same as @atlassian-dc-mcp/confluence (proxy localhost:8443 + keychain token).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

async function getPageMeta(contentId, expand = 'version,space,ancestors,body.storage') {
  return confluenceApi('GET', `/rest/api/content/${contentId}?expand=${expand}`);
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
      message: versionComment || 'Updated via confluence-move-mcp from file',
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
  name: 'confluence-move-mcp',
  version: '1.1.0',
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

const transport = new StdioServerTransport();
await server.connect(transport);
