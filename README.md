# confluence-move-mcp

Temporary MCP server that moves (reparents) Confluence Data Center pages.

Use while waiting for upstream [`parentId` on `confluence_updateContent`](https://github.com/b1ff/atlassian-dc-mcp/pull/67). After that lands, this server can be removed from `~/.cursor/mcp.json`.

## Auth

Same sources as `@atlassian-dc-mcp/confluence`:

- `CONFLUENCE_HOST` (env or `~/.atlassian-dc-mcp/confluence.env`)
- `CONFLUENCE_API_TOKEN` (env), or macOS Keychain service `atlassian-dc-mcp` / account `confluence-token`

## Tools

- `confluence_movePage` — move one page under a new parent
- `confluence_movePages` — move several pages (sequential)

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
