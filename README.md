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
| `confluence_getStorageToFile` | Dump page `body.storage` to a local XML file (+ current version) |
| `confluence_updateStorageFromFile` | Publish page storage XML from file (auto version bump) |
| `confluence_listAttachments` | List attachments on a page |
| `confluence_downloadAttachmentToFile` | Download attachment binary to a local file |
| `confluence_uploadAttachmentFromFile` | Upload / new version of attachment from local file |
| `confluence_listComments` / `addComment` / `replyToComment` | Footer (page) comments; quote page text in the body (no inline) |
| `confluence_listLabels` / `addLabels` / `removeLabels` / `setLabels` | Page labels (`global` / `my`) |
| `confluence_listSpaceTemplates` | List space page templates (`spaceKey` required) |
| `confluence_getSpaceTemplateToFile` | Dump space template body to a local XML file |
| `confluence_createSpaceTemplateFromFile` | Create new space template from file (POST); optional `labels` / `copyLabelsFromContentId` |
| `confluence_updateSpaceTemplateFromFile` | Publish space template body from file |
| `confluence_setSpaceTemplateLabels` | Set labels on a space template (body unchanged) |
| `confluence_syncPageToSpaceTemplate` | **Fast path:** copy page body **and labels** → space Create-from-template snapshot |
| `confluence_deleteSpaceTemplate` / `…Templates` | **Destructive.** Delete Create template(s). Requires human chat OK + `confirm: "DELETE"` + exact name(s). Annotated `destructiveHint`. |

### Fast path for large pages (BRD/SRS/…)

1. `confluence_getStorageToFile` → local `….xml`
2. Surgical edit with Python/`StrReplace` on the file (preserve entities; do not re-escape)
3. `confluence_updateStorageFromFile` (omit `version` to auto-bump, or pass current+1)
4. Verify with `user-confluence-dc` / `confluence_getContent` `bodyMode: text`
5. If the page is also a Create-from-template snapshot → sync space template (below)
6. Delete the temp file

For **small** pages, keep using `user-confluence-dc` `confluence_updateContent` directly.

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
