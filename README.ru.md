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

Токены и `*.env` **не** коммитить. См. [SECURITY.md](./SECURITY.md).

## Tools

| Tool | Когда использовать |
|------|--------------------|
| `confluence_movePage` / `confluence_movePages` | Только смена родителя (reparent) |
| `confluence_listChildPages` | Прямые дочерние страницы + `position` в дереве |
| `confluence_reorderPage` | Порядок среди siblings / append: `above` \| `below` \| `append` через DC `movepage.action` |
| `confluence_setChildPageOrder` | Точный полный порядок детей (permutation; последовательный movepage) |
| `confluence_getStorageToFile` | Выгрузить `body.storage` страницы в локальный XML (+ текущая version) |
| `confluence_resolveTinyUrl` | Tiny-ссылка `/x/{code}` → page id / title / space (без XML) |
| `confluence_updateStorageFromFile` | Опубликовать storage XML из файла (автоинкремент version) |
| `confluence_storage_listHeadings` | Заголовки в локальном storage-файле (без тел секций) |
| `confluence_storage_getSection` | Одна секция: text / markdown / фрагмент storage (опционально `maxChars`). См. [Ссылки в text/markdown](#ссылки-в-textmarkdown). |
| `confluence_storage_replaceSection` | Заменить тело одной секции на диске (`dryRun`) |
| `confluence_storage_listMacros` | Инвентарь макросов (без тел) |
| `confluence_storage_replaceMacroBody` | Заменить тело одного макроса (напр. mermaid CDATA) |
| `confluence_listAttachments` | Список вложений страницы |
| `confluence_downloadAttachmentToFile` | Скачать вложение в локальный файл |
| `confluence_uploadAttachmentFromFile` | Загрузить / новую версию вложения из файла |
| `confluence_listComments` / `addComment` / `replyToComment` | Комментарии под страницей; цитату из текста — в теле (без создания inline) |
| `confluence_listInlineComments` / `replyToInlineComment` | Читать inline (open / resolved) и отвечать в треде |
| `confluence_listLabels` / `addLabels` / `removeLabels` / `setLabels` | Метки страницы (`global` / `my`) |
| `confluence_listSpaceTemplates` | Список page-шаблонов пространства (`spaceKey` обязателен) |
| `confluence_getSpaceTemplateToFile` | Выгрузить тело space template в локальный XML |
| `confluence_createSpaceTemplateFromFile` | Создать space template из файла (POST); опционально `labels` / `copyLabelsFromContentId` |
| `confluence_updateSpaceTemplateFromFile` | Обновить тело space template из файла |
| `confluence_setSpaceTemplateLabels` | Метки space template (тело не трогает) |
| `confluence_syncPageToSpaceTemplate` | **Быстрый путь:** тело страницы **и метки** → снимок Create-from-template |
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

1. `confluence_getStorageToFile` → `/path/to/page.xml`
2. `confluence_storage_listHeadings` / `getSection` (`format: text`) — **не** `@` и не Read dump-файл в чат
3. `confluence_storage_replaceSection` или `confluence_storage_replaceMacroBody` (при сомнении `dryRun`)
4. `confluence_updateStorageFromFile` (без `version` — автоинкремент, или передать current+1)
5. Проверка через `user-confluence-dc` / `confluence_getContent` `bodyMode: text` (с лимитом)
6. Если страница — снимок Create from template → синхронизировать space template (ниже)
7. Удалить временный файл

Эти tools **не публикуют** и **не возвращают** полный XML. Python/`StrReplace` по dump — fallback, если кейс не покрыт.

**Не** гонять всю страницу через Markdown (макросы и layout не восстановятся).

Для **крошечных** страниц, которые не заготовки, — `user-confluence-dc` `confluence_updateContent`.

### Ссылки в text/markdown

В storage page-link часто лежит как пустой `ac:link` с целью только в атрибутах `ri:*` (UI подставляет title). `format: storage` не меняется. В `format: text` / `markdown` (и в заголовках, где только ссылка) конвертер подставляет label, чтобы агент не считал поле пустым:

1. Сначала видимый текст якоря (`ac:plain-text-link-body` / `ac:link-body`); `ri:content-title` при этом не дублировать.
2. Иначе первая цель: `ri:page` / `ri:blog-post` → `ri:content-title` и ` [spaceKey]`, если есть `ri:space-key`; `ri:url` → `ri:value`; `ri:attachment` → `ri:filename`; `ri:space` → key/name; `ri:user` → `[user]` (ФИО не выдумывать).
3. Markdown: те же labels; для `ri:url` допустимо `[label](url)`. У page-link — голый title (без выдуманных `/wiki/…`).
4. Без REST за title/id; без дефолтного space, если нет `ri:space-key`; tiny/`pageId` здесь не резолвятся.

Тот же контракт, что у `user-confluence-dc` `confluence_getContent` с `bodyMode: text`. Макросы кроме `expand` в getSection text по-прежнему `[macro: …]` — тела внутри них не обходятся.

### Быстрый путь: страница → space template («Создать из шаблона»)

Каталог / BSA-страница = источник истины. Space template = снимок для «Создать из шаблона».

```
confluence_syncPageToSpaceTemplate
  contentId: "<pageId>"
  spaceKey: "<spaceKey>"
  templateId: "<templateId>"
  descriptionSuffix: "(примечание)"   # optional
  # copyPageLabels: true по умолчанию — метки шаблона берутся со страницы
```

Замечания по DC API:

- Список: `/rest/experimental/template/page?spaceKey=…`
- GET только по template id часто **404** — всегда передавать `spaceKey`
- Update: `PUT /rest/experimental/template` с `templateType: "page"` и `body.storage`
- Delete: `DELETE /rest/experimental/template/{id}` — только через MCP delete tools после **явного** подтверждения человека (`confirm: "DELETE"` + точное `confirmName` / `confirmNames`). Корзины нет.

## Метки (страницы + «Создать из шаблона»)

Confluence копирует **метки space template** на страницы, созданные из шаблона. Метки вешаются на страницу-источник, затем sync (или сразу на шаблон). Новые страницы из «Создать из шаблона» их наследуют.

| Tool | Когда |
|------|-------|
| `confluence_listLabels` | Прочитать метки страницы |
| `confluence_addLabels` | Добавить, не снимая остальные |
| `confluence_removeLabels` | Снять по имени |
| `confluence_setLabels` | Заменить **global**-метки (личные `my:` не трогает) |
| `confluence_setSpaceTemplateLabels` | Только метки шаблона (тело не меняет) |

`confluence_syncPageToSpaceTemplate` копирует **global**-метки страницы на шаблон (`copyPageLabels` по умолчанию true). Если на странице меток нет — оставляет текущие метки шаблона. Явный список: `labels: [...]`. Create/update-from-file принимают `labels` и `copyLabelsFromContentId`.

API страниц: `GET/POST /rest/api/content/{id}/label`, `DELETE …/label?name=`. Метки шаблона — в PUT experimental template (если не передать, DC может стереть — tools всегда шлют список, кроме `keepLabels: false` без замены).

## Комментарии под страницей

Inline нет. Чтобы было понятно, о чём речь — цитату из страницы пишите в теле комментария.

| Tool | Когда |
|------|-------|
| `confluence_listComments` | Список footer-комментариев (`location=footer`; `depth` root\|all) |
| `confluence_addComment` | Новый комментарий под страницей |
| `confluence_replyToComment` | Ответ в треде |

`bodyFormat`: `plain` (по умолчанию — `<p>`, пустая строка = абзац) или `storage` (сырой storage XML).

## Inline-комментарии (только чтение + ответ)

**Не** создаёт новые якоря на тексте. Новый комментарий «про фрагмент» — footer с цитатой.

| Tool | Когда |
|------|-------|
| `confluence_listInlineComments` | Список inline; `status`: `open` (на странице) \| `resolved` \| `all` |
| `confluence_replyToInlineComment` | Ответ в существующем inline-треде |

В каждом элементе: `status` (`open`\|`resolved`), `visibleOnPage` (true, если виден на странице), `originalSelection` (заякорённый текст, если есть).

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
