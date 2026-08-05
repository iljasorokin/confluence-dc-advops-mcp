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
| `confluence_listSpaceTemplates` | List space page templates (`spaceKey` required) |
| `confluence_getSpaceTemplateToFile` | Dump space template body to a local XML file |
| `confluence_createSpaceTemplateFromFile` | Create new space template from file (POST) |
| `confluence_updateSpaceTemplateFromFile` | Publish space template body from file |
| `confluence_syncPageToSpaceTemplate` | **Fast path:** copy page body → space Create-from-template snapshot |
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
```

DC notes:

- List: `/rest/experimental/template/page?spaceKey=…`
- GET by template id alone often **404** — always pass `spaceKey`
- Update: `PUT /rest/experimental/template` with `templateType: "page"` and `body.storage`
- Delete: `DELETE /rest/experimental/template/{id}` — only via MCP delete tools after **human** confirmation (`confirm: "DELETE"` + exact `confirmName` / `confirmNames`). No trash restore.

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
