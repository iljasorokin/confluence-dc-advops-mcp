# confluence-dc-advops-mcp

Локальные MCP-инструменты для Confluence Data Center в Cursor.

Работает через **тот же proxy/auth**, что и `@atlassian-dc-mcp/confluence`
(локальный TLS-proxy + токен из Keychain / env). Предпочитать эти tools
вместо ad-hoc `curl` к публичному hostname Confluence.

Английская версия: [README.md](./README.md).

## Авторизация

Те же источники, что у `@atlassian-dc-mcp/confluence`:

- `CONFLUENCE_HOST` (env или `~/.atlassian-dc-mcp/confluence.env`) — обычно локальный proxy, напр. `https://localhost:8443`
- `CONFLUENCE_API_TOKEN` (env) или macOS Keychain: service `atlassian-dc-mcp` / account `confluence-token`

Токены и `*.env` **не** коммитить.

## Tools

| Tool | Когда использовать |
|------|--------------------|
| `confluence_movePage` / `confluence_movePages` | Только смена родителя (reparent) |
| `confluence_listChildPages` | Прямые дочерние страницы + `position` в дереве |
| `confluence_reorderPage` | Порядок среди siblings / append: `above` \| `below` \| `append` через DC `movepage.action` |
| `confluence_setChildPageOrder` | Точный полный порядок детей (permutation; последовательный movepage) |
| `confluence_getStorageToFile` | Выгрузить `body.storage` страницы в локальный XML (+ текущая version) |
| `confluence_updateStorageFromFile` | Опубликовать storage XML из файла (автоинкремент version) |
| `confluence_listAttachments` | Список вложений страницы |
| `confluence_downloadAttachmentToFile` | Скачать вложение в локальный файл |
| `confluence_uploadAttachmentFromFile` | Загрузить / новую версию вложения из файла |
| `confluence_listSpaceTemplates` | Список page-шаблонов пространства (`spaceKey` обязателен) |
| `confluence_getSpaceTemplateToFile` | Выгрузить тело space template в локальный XML |
| `confluence_createSpaceTemplateFromFile` | Создать space template из файла (POST) |
| `confluence_updateSpaceTemplateFromFile` | Обновить тело space template из файла |
| `confluence_syncPageToSpaceTemplate` | **Быстрый путь:** тело страницы → снимок Create-from-template |
| `confluence_deleteSpaceTemplate` / `…Templates` | **Деструктивно.** Удаление Create-шаблона(ов). Нужно явное OK в чате + `confirm: "DELETE"` + точное имя/имена. `destructiveHint`. |

### Порядок страниц среди siblings (DC 9.x)

Cloud-эндпоинт `PUT /rest/api/content/{id}/move/...` на DC **отсутствует**.
Используется UI-эндпоинт Space tools → Reorder pages:

1. `confluence_listChildPages` (`parentId`) — дети + `position`
2. `confluence_reorderPage` — `contentId` + `targetId` + `position`: `above` | `below` | `append`
3. `confluence_setChildPageOrder` — полный порядок: `childIds` = permutation всех текущих детей

Не путать с `confluence_movePage` (только смена родителя через `ancestors`).

Перед большим reorder — спросить человека в чате.

### Быстрый путь для крупных страниц (BRD/SRS/…)

1. `confluence_getStorageToFile` → локальный `….xml`
2. Точечное правление файла (Python / `StrReplace`; сущности не переэкранировать)
3. `confluence_updateStorageFromFile` (без `version` — автоинкремент, или передать current+1)
4. Проверка через `user-confluence-dc` / `confluence_getContent` `bodyMode: text`
5. Если страница — снимок Create from template → синхронизировать space template (ниже)
6. Удалить временный файл

Для **маленьких** страниц — `user-confluence-dc` `confluence_updateContent` напрямую.

### Быстрый путь: страница → space template («Создать из шаблона»)

Каталог / BSA-страница = источник истины. Space template = снимок для «Создать из шаблона».

```
confluence_syncPageToSpaceTemplate
  contentId: "<pageId>"
  spaceKey: "<spaceKey>"
  templateId: "<templateId>"
  descriptionSuffix: "(примечание)"   # optional
```

Замечания по DC API:

- Список: `/rest/experimental/template/page?spaceKey=…`
- GET только по template id часто **404** — всегда передавать `spaceKey`
- Update: `PUT /rest/experimental/template` с `templateType: "page"` и `body.storage`
- Delete: `DELETE /rest/experimental/template/{id}` — только через MCP delete tools после **явного** подтверждения человека (`confirm: "DELETE"` + точное `confirmName` / `confirmNames`). Корзины нет.

## Конфиг Cursor

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

После правок `index.js` перезагрузить MCP servers в Cursor, чтобы появились новые tools.
