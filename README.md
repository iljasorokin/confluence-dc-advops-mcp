# confluence-dc-advops-mcp

Local MCP helpers for Confluence Data Center used from Cursor.

Русская документация: [README.ru.md](./README.ru.md).

Talks to the **same proxy/auth** as `@atlassian-dc-mcp/confluence`
(local TLS proxy + token from keychain / env). Prefer these tools over
ad-hoc `curl` to the public Confluence hostname.

## Auth

Same sources as `@atlassian-dc-mcp/confluence`:

- `CONFLUENCE_HOST` (env or `~/.atlassian-dc-mcp/confluence.env`) — typically your local proxy, e.g. `https://localhost:8443`
- `CONFLUENCE_API_TOKEN` (env), or macOS Keychain service `atlassian-dc-mcp` / account `confluence-token`

Do **not** commit tokens or `*.env` files. See [SECURITY.md](./SECURITY.md).

## Tools

| Tool | When |
|------|------|
| `confluence_movePage` / `confluence_movePages` | Reparent only (until upstream `parentId` on update) |
| `confluence_listChildPages` | Direct children + tree `position` |
| `confluence_reorderPage` | Sibling order / append: `above` \| `below` \| `append` via DC `movepage.action` |
| `confluence_setChildPageOrder` | Exact full child order (permutation; sequential movepage) |
| `confluence_listVersions` | Page version metadata only (who / when / message); no bodies |
| `confluence_getStorageToFile` | Dump page `body.storage` to a local XML file (current or `version=N` historical) |
| `confluence_resolveTinyUrl` | Tiny link `/x/{code}` → page id / title / space (no XML) |
| `confluence_updateStorageFromFile` | Publish page storage XML from file (auto version bump) |
| `confluence_storage_listHeadings` | Headings in a local storage file (no bodies) |
| `confluence_storage_getSection` | One section as text / markdown / storage fragment (optional `maxChars` cap). See [Links in text/markdown](#links-in-textmarkdown). |
| `confluence_storage_replaceSection` | Replace one section body on disk (`dryRun` supported) |
| `confluence_storage_listMacros` | Macro inventory (no bodies) |
| `confluence_storage_replaceMacroBody` | Replace one macro body (e.g. mermaid CDATA) |
| `confluence_listAttachments` | List attachments on a page |
| `confluence_downloadAttachmentToFile` | Download attachment binary to a local file |
| `confluence_uploadAttachmentFromFile` | Upload / new version of attachment from local file |
| `confluence_listComments` / `addComment` / `replyToComment` | Footer (page) comments; quote page text in the body (no inline create) |
| `confluence_listInlineComments` / `replyToInlineComment` | Read inline comments (open vs resolved) and reply in thread |
| `confluence_listLabels` / `addLabels` / `removeLabels` / `setLabels` | Page labels (`global` / `my`) |
| `confluence_listSpaceTemplates` | List space page templates (`spaceKey` required) |
| `confluence_getSpaceTemplateToFile` | Dump space template body to a local XML file |
| `confluence_createSpaceTemplateFromFile` | Create new space template from file (POST); optional `labels` / `copyLabelsFromContentId` |
| `confluence_updateSpaceTemplateFromFile` | Publish space template body from file |
| `confluence_setSpaceTemplateLabels` | Set labels on a space template (body unchanged) |
| `confluence_syncPageToSpaceTemplate` | **Fast path:** copy page body **and labels** → space Create-from-template snapshot |
| `confluence_deleteSpaceTemplate` / `…Templates` | **Destructive.** Delete Create template(s). Requires human chat OK + `confirm: "DELETE"` + exact name(s). Annotated `destructiveHint`. |

### Fast path for large pages (BRD/SRS/…)

1. `confluence_getStorageToFile` → `/path/to/page.xml`
2. `confluence_storage_listHeadings` / `getSection` (`format: text`) — **do not** `@` or Read the dump file into chat
3. `confluence_storage_replaceSection` or `confluence_storage_replaceMacroBody` (`dryRun` first if unsure)
4. `confluence_updateStorageFromFile` (omit `version` to auto-bump, or pass current+1)
5. Verify with `user-confluence-dc` / `confluence_getContent` `bodyMode: text` (limit chars)
6. If the page is also a Create-from-template snapshot → sync space template (below)
7. Delete the temp file

These storage tools **do not publish** and **do not return** the full XML. Python/`StrReplace` on the dump is a fallback when they do not cover the case.

### Page versions (who / when — not full blame)

1. `confluence_listVersions` — metadata only (`number`, `when`, `message`, `by`). Paginate with `start` / `limit`; cap with `maxResults`.
2. To inspect an old body: `confluence_getStorageToFile` with `version: N` → local XML, then `storage_getSection` / search on disk. Do **not** pull historical XML into chat.
3. Not git-blame: a version author is who saved that snapshot; use snippet search on the dump for “who wrote this line”.

Do **not** round-trip the whole page through Markdown (macros/layout will not survive).

For **tiny** pages that are not templates, `user-confluence-dc` `confluence_updateContent` is still ok.

### Links in text/markdown

Confluence often stores page links as empty `ac:link` with the target only in `ri:*` attributes (UI fills the title). `format: storage` is unchanged. For `format: text` / `markdown` (and headings that are only a link), the converter fills a label so agents do not treat the field as empty:

1. Prefer visible anchor text (`ac:plain-text-link-body` / `ac:link-body`); do not also append `ri:content-title`.
2. Otherwise first target: `ri:page` / `ri:blog-post` → `ri:content-title` plus ` [spaceKey]` when `ri:space-key` is set; `ri:url` → `ri:value`; `ri:attachment` → `ri:filename`; `ri:space` → key/name; `ri:user` → `[user]` (no invented display name).
3. Markdown: same labels; `ri:url` may become `[label](url)`. Page links stay bare titles (no invented `/wiki/…` URLs).
4. No REST lookup of titles/ids; no default space when `ri:space-key` is missing; tiny/`pageId` not resolved here.

Same contract as `user-confluence-dc` `confluence_getContent` with `bodyMode: text` (upstream mapper). Non-`expand` macros still appear as `[macro: …]` stubs in getSection text — bodies inside those macros are not walked.

### Fast path: page → space template (Create from template)

Catalog / BSA page = source of truth. Space template = snapshot for «Create from template».

```
confluence_syncPageToSpaceTemplate
  contentId: "<pageId>"
  spaceKey: "<spaceKey>"
  templateId: "<templateId>"
  descriptionSuffix: "(sync note)"   # optional
  # copyPageLabels: true by default — template labels come from the page
```

DC notes:

- List: `/rest/experimental/template/page?spaceKey=…`
- GET by template id alone often **404** — always pass `spaceKey`
- Update: `PUT /rest/experimental/template` with `templateType: "page"` and `body.storage`
- Delete: `DELETE /rest/experimental/template/{id}` — only via MCP delete tools after **human** confirmation (`confirm: "DELETE"` + exact `confirmName` / `confirmNames`). No trash restore.

## Labels (pages + Create from template)

Confluence copies **space-template labels** onto pages created from that template. Put labels on the catalog page, then sync (or set them on the template). New pages from «Create from template» inherit them.

| Tool | When |
|------|------|
| `confluence_listLabels` | Read labels on a page |
| `confluence_addLabels` | Add without removing others |
| `confluence_removeLabels` | Remove by name |
| `confluence_setLabels` | Replace **global** labels (`my:` left alone) |
| `confluence_setSpaceTemplateLabels` | Labels on the template only (keeps body) |

`confluence_syncPageToSpaceTemplate` copies the page’s **global** labels onto the template (`copyPageLabels` default true). If the page has none, current template labels are kept. Pass `labels: [...]` to set them explicitly. Create/update-from-file accept `labels` and `copyLabelsFromContentId`.

Page API: `GET/POST /rest/api/content/{id}/label`, `DELETE …/label?name=`. Template labels go in the experimental template PUT payload (omitting them can wipe labels on DC — tools always send a list unless you set `keepLabels: false` with no replacement).

## Footer comments (page comments)

No inline comments. Put a quote from the page in the comment body so the subject is clear.

| Tool | When |
|------|------|
| `confluence_listComments` | List footer comments (`location=footer`; `depth` root\|all) |
| `confluence_addComment` | New footer comment under a page |
| `confluence_replyToComment` | Reply in a footer thread |

`bodyFormat`: `plain` (default — wrap in `<p>`, blank lines = paragraphs) or `storage` (raw Confluence storage XML).

## Inline comments (read + reply only)

Does **not** create new text anchors. Use footer comments with a quote if you need a new note.

| Tool | When |
|------|------|
| `confluence_listInlineComments` | List inline comments; `status`: `open` (on page) \| `resolved` \| `all` |
| `confluence_replyToInlineComment` | Reply in an existing inline thread |

Each item includes `status` (`open`\|`resolved`), `visibleOnPage` (true when open on the page), and `originalSelection` (anchored text when present).

## Cursor config

```json
"confluence-dc-advops": {
  "command": "node",
  "args": ["/path/to/confluence-dc-advops-mcp/index.js"],
  "env": {
    "CONFLUENCE_HOST": "https://localhost:8443",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

After changing `index.js`, reload MCP servers in Cursor so new tools appear.
