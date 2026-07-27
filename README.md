# confluence-move-mcp

Local MCP helpers for Confluence Data Center used from Cursor.

Talks to the **same proxy/auth** as `@atlassian-dc-mcp/confluence`
(`CONFLUENCE_HOST=https://localhost:8443` + token from keychain). Prefer these
tools over inventing raw `curl` to `cnfl.upzero.net`.

## Auth

Same sources as `@atlassian-dc-mcp/confluence`:

- `CONFLUENCE_HOST` (env or `~/.atlassian-dc-mcp/confluence.env`)
- `CONFLUENCE_API_TOKEN` (env), or macOS Keychain service `atlassian-dc-mcp` / account `confluence-token`

## Tools

| Tool | When |
|------|------|
| `confluence_movePage` / `confluence_movePages` | Reparent only (until upstream `parentId` on update) |
| `confluence_getStorageToFile` | Dump `body.storage` to a local XML file (+ current version) |
| `confluence_updateStorageFromFile` | Publish storage XML from file (auto version bump) |

### Fast path for large templates (BRD/SRS/…)

1. `confluence_getStorageToFile` → `_tmp_….xml`
2. Surgical edit with Python/`StrReplace` on the file (preserve entities; do not re-escape)
3. `confluence_updateStorageFromFile` (omit `version` to auto-bump, or pass current+1)
4. Verify with `user-confluence-dc` / `confluence_getContent` `bodyMode: text`
5. Delete the temp file

For **small** pages, keep using `user-confluence-dc` `confluence_updateContent` directly.

## Cursor config

```json
"confluence-move": {
  "command": "node",
  "args": ["/Users/iljasorokin/confluence-move-mcp/index.js"],
  "env": {
    "CONFLUENCE_HOST": "https://localhost:8443",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

After changing `index.js`, reload MCP servers in Cursor so new tools appear.
