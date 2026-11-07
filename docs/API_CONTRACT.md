# CQA API — контракт для фронтенда, v1

Статус: контракт принят с дополнениями от 2026-11-07. Реализация использует FastAPI/OpenAPI и `backend/app/schemas.py`; первый доступный провайдер — `LLM_PROVIDER=fake`. JSON-файлы в `docs/examples/` генерируются только из реальных ответов демо-API на синтетических данных. Результаты аудита DEV см. в `DATA_NOTES.md`.

Базовый путь `/api`. Интерфейс работает с одним origin; при отдельном сервере разработки разрешённые origin задаются `CORS_ORIGINS`. Авторизация для демонстрации не требуется. `/`, если существует `frontend/`, раздаёт его как статику только для чтения; `/api`, `/docs` и `/openapi.json` имеют приоритет над статикой.

Ответы раздачи `frontend/` получают `Cache-Control: no-cache`, включая HTML, JS, HEAD, 304, перенаправления и ошибки статики. Это требует проверки актуальности при повторном использовании сохранённого файла, а не запрещает его хранение. Штатные `ETag` и `Last-Modified` файлов сохраняются; условные запросы продолжают получать 304 без тела. Заголовки API (включая неизвестные `/api`-пути), `/docs` и `/openapi.json` этой политикой не меняются. После обновления ранее открытого интерфейса выполните Ctrl+Shift+R, чтобы получить новую политику кеширования.

## 1. Общие соглашения

- UTF-8, JSON `Content-Type: application/json`, кроме загрузки файла. Названия полей `snake_case`.
- Внутренние идентификаторы — непрозрачные строки UUID. Фронтенд их не конструирует. Внешние `group_id` и `conversation_id` — строки источника; совпадение внешнего ID в разных группах допустимо.
- Все серверные даты — ISO 8601 UTC, например `2026-11-07T10:00:00Z`. Исходный `timestamp` сообщения сохраняется без изменений.
- Все поля описанных ответов присутствуют. Отсутствующее скалярное значение — `null`, список — `[]`. В запросах необязательное поле допускает пропуск только там, где задано значение по умолчанию.
- Числа баллов, весов, нормирования, денежных затрат и длительностей — JSON numbers, не строки. Внутренние вычисления баллов выполняются в Decimal без промежуточного округления. Округлённый итог возвращается числом; фронтенд форматирует его до `scoring_policy.decimals` знаков и не пересчитывает.
- Для списков: `limit` (целое 1–100, по умолчанию 25), `offset` (целое >=0, по умолчанию 0). Точный `total` относится к применённым фильтрам. Сортировка по умолчанию `created_at DESC, id ASC`; разговоры — `group_id ASC, conversation_id ASC, id ASC`.
- Неизвестные поля запросов отклоняются с 422. Неизвестные дополнительные поля ответов фронтенд игнорирует. Новые значения перечислений отображаются нейтрально; нельзя падать из-за нового значения.
- Тексты транскрипта и обоснований выводятся как текст, без исполнения HTML/JavaScript.
- Сервер никогда не получает ключи модели или подписанный URL организаторов от фронтенда. Фронтенд передаёт только `group_id`. Конфигурация провайдера находится на сервере.

### Конверты

Каждый успешный JSON-ответ (включая 201 и 202):

```text
Success<T> = { data: T, meta: { request_id: string } }
Page<T> = { items: T[], total: integer, limit: integer, offset: integer }
```

Ошибка HTTP 4xx/5xx:

```text
Failure = {
  error: {
    code: string,
    message: string,             // безопасное русское пояснение для интерфейса
    details: ErrorDetail[],
    retryable: boolean
  },
  meta: { request_id: string }
}
ErrorDetail = { path: (string | integer)[], code: string, message: string }
```

`path` указывает на поле тела или параметр (`["body","criteria",0,"weight"]`, `["query","limit"]`). Значение ошибочного ввода, секреты, URL, сырой ответ внешнего сервиса и traceback в ошибку не включаются. Все ошибки FastAPI, включая 422/404/405, приводятся к этому конверту.

| HTTP | `error.code` | Смысл |
| --- | --- | --- |
| 400 | `INVALID_JSON`, `INVALID_DATASET` | Не читается JSON или неверен конверт набора, включая `isSuccess != true` |
| 404 | `NOT_FOUND` | Объект не найден |
| 405 | `METHOD_NOT_ALLOWED` | Метод не поддерживается |
| 409 | `CONFLICT`, `GROUP_MISMATCH`, `DUPLICATE_OPEN_APPEAL`, `APPEAL_ALREADY_RESOLVED`, `VERSION_CONFLICT`, `INCOMPARABLE_EVALUATIONS` | Конфликт состояния/принадлежности |
| 413 | `PAYLOAD_TOO_LARGE` | Превышен настраиваемый лимит файла/тела |
| 422 | `VALIDATION_ERROR`, `NO_ACTIVE_CHECKLIST`, `INVALID_ANSWER`, `INVALID_EVIDENCE` | Неверные поля, шкала, N/A, ссылка на сообщение |
| 429 | `BUSY` | Сервер перегружен; `retryable=true`, заголовок `Retry-After` в секундах |
| 502 | `DATASET_UPSTREAM_ERROR` | Организаторы вернули ошибку/невалидный ответ |
| 503 | `PROVIDER_NOT_CONFIGURED`, `DATASET_NOT_CONFIGURED`, `SERVICE_UNAVAILABLE` | Нет необходимой серверной настройки/доступности |
| 504 | `DATASET_TIMEOUT` | Истёк тайм-аут загрузки |
| 500 | `INTERNAL_ERROR` | Неожиданная внутренняя ошибка |

Ошибки отдельной записи при импорте не превращают весь корректный пакет в HTTP-ошибку. Ошибки модели после постановки задания видны в `Job.items`, а не как 500 на успешный GET задания.

## 2. Сводка маршрутов

Во всех строках тело ответа обёрнуто в `Success<T>`. Полные модели и инварианты ниже.

| Метод и путь | Запрос | HTTP / `data` |
| --- | --- | --- |
| GET `/api/health` | Нет | 200 / `Health` |
| POST `/api/imports/dataset` | `DatasetImportRequest` | 200 / `ImportReport` |
| POST `/api/imports/file` | multipart `file`, необязательный `group_id` | 200 / `ImportReport` |
| GET `/api/conversations` | Фильтры и пагинация | 200 / `Page<ConversationSummary>` |
| GET `/api/conversations/{id}` | Необязательный `revision_id` | 200 / `ConversationDetail` |
| GET `/api/conversations/{id}/revisions` | Пагинация | 200 / `Page<ConversationRevision>` |
| GET `/api/checklists` | Пагинация | 200 / `Page<Checklist>` |
| POST `/api/checklists` | `CreateChecklistRequest` | 201 / `ChecklistVersion` |
| GET `/api/checklists/{id}` | Нет | 200 / `Checklist` |
| GET `/api/checklists/{id}/versions` | Пагинация | 200 / `Page<ChecklistVersion>` |
| POST `/api/checklists/{id}/versions` | `CreateVersionRequest` | 201 / `ChecklistVersion` |
| POST `/api/checklists/validate` | `ChecklistDefinition` | 200 / `ValidationReport` |
| GET `/api/checklist-versions/{id}` | Нет | 200 / `ChecklistVersion` |
| POST `/api/checklist-versions/{id}/activate` | `{ expected_active_version_id: string | null }` | 200 / `ActivationResult` |
| POST `/api/evaluations` | `EvaluationRequest` | 202 / `Job` |
| GET `/api/jobs/{id}` | Нет | 200 / `Job` |
| GET `/api/evaluations` | Фильтры и пагинация | 200 / `Page<EvaluationSummary>` |
| GET `/api/evaluations/{id}` | Нет | 200 / `Evaluation` |
| GET `/api/evaluations/compare` | `left_id`, `right_id` | 200 / `EvaluationComparison` |
| POST `/api/appeals` | `CreateAppealRequest` | 201 / `Appeal` |
| GET `/api/appeals` | Фильтры и пагинация | 200 / `Page<Appeal>` |
| GET `/api/appeals/{id}` | Нет | 200 / `Appeal` |
| POST `/api/appeals/{id}/decision` | `AppealDecisionRequest` | 200 / `AppealDecisionResult` |
| GET `/api/history` | Фильтры и пагинация | 200 / `Page<HistoryEvent>` |

Статические пути `checklists/validate` и `evaluations/compare` регистрируются до маршрутов с `{id}`.

## 3. Состояние и настройки

```text
Health = {
  status: "ok" | "degraded",
  api_version: "1",
  database_ready: boolean,
  provider: "fake" | "openai" | "anthropic",
  model: string | null,
  is_demo: boolean,
  evaluation_ready: boolean,
  dataset_ready: boolean,
  prompt_version: string,        // версия промпта запущенного сервера; добавлено для preflight
  active_checklist_version_id: string | null,
  scoring_policy: ScoringPolicy
}
ScoringPolicy = {
  rounding: "half_up" | "half_even",
  decimals: integer,
  gross_error_zeroes_total: boolean
}
```

`is_demo` истинен только для fake. В интерфейсе это постоянная видимая отметка «Демо: оценки синтетические». Ненастроенный настоящий провайдер не заменяется fake автоматически. Деградация внешней модели не закрывает доступ к сохранённым результатам, чек-листам и апелляциям. При недоступной БД — HTTP 503 с общим конвертом ошибки.

FakeLLM даёт детерминированно разнообразные ответы для проверки интерфейса: бинарные `false`, разные допустимые ступени шкалы, разрешённый N/A с `na_reason`, флаги `true` и `manual_review` с причиной. Выбор зависит от SHA-256 канонического JSON нормализованного `transcript` и `criterion_id`; при тех же данных и критериях он не зависит от состава пакета, порядка критериев, повторов запроса или счётчика вызовов. При наличии сообщений из `hold` / `internal_consult` с `client_facing=false` демо использует их как доказательство для применимого критерия, чтобы штатная проверка сформировала предупреждение и ручную проверку. Такие ответы не подтверждают смысловую правильность оценки.

Версия поведения FakeLLM входит в настройки ключа кеша. Чтобы увидеть новое демо-поведение, необходимо создать новую оценку: после изменения версии поведения старый кеш не подходит, поэтому `force=true` для этого не требуется. Уже сохранённые оценки и их история автоматически не переписываются.

В health возвращаются только названия провайдера/модели и безопасные флаги готовности. Значения `DATASET_URL`, ключей и URL провайдера не возвращаются. `SCORE_ROUNDING`, `SCORE_DECIMALS`, `GROSS_ERROR_ZEROES_TOTAL`, `RATIONALE_LANGUAGE`, `LLM_MAX_CONCURRENCY`, тайм-ауты и повторы настраиваются на сервере. Действующая политика фиксируется в каждой оценке; изменение настройки не меняет старые оценки и пересчёт их апелляций.

При первом запуске с пустым хранилищем сервер в одной транзакции создаёт исходный чек-лист из seed JSON, сохраняет версию 1 и активирует её. Поэтому готовый сервер сразу возвращает её ID в `active_checklist_version_id`. Инициализация идемпотентна: последующие запуски не создают дубликаты и не заменяют выбранную человеком активную версию; изменение seed-файла не переписывает сохранённые версии.

Уточнения seed после проверки настоящей модели применяются к уже существующей базе через создание новой версии с `activate=true` и обеими проверками конфликтов. Поэтому номер активной версии в рабочей базе может отличаться от первой версии свежей установки с тем же seed. Оценка всегда сохраняет фактически использованные `checklist_version_id`, `checklist_snapshot` и `usage.prompt_version`; фронтенд не выводит их из текущего seed.

## 4. Импорт

```text
DatasetImportRequest = { group_id: string }
ImportReport = {
  import_id: string,
  group_id: string,
  received: integer,
  created: integer,
  unchanged: integer,
  revised: integer,
  skipped: integer,
  errors: ImportIssue[],
  warnings: ImportIssue[],
  unknown_system_phrases: UnknownPhrase[],
  created_at: string
}
ImportIssue = {
  record_index: integer | null,  // индекс входной записи, начиная с 0
  conversation_id: string | null, // внешний ID, если был доступен
  message_id: integer | null,   // позиция реплики, начиная с 1
  code: string,
  message: string,
  path: (string | integer)[]
}
UnknownPhrase = { text: string, count: integer }
```

`received = created + unchanged + revised + skipped`. `revised` — изменившаяся запись уже известного разговора, для которой создана новая ревизия. Одинаковое содержимое повторно не создаёт ревизию. Повторяющиеся внешние ID внутри одного входного набора после первого вхождения пропускаются с `DUPLICATE_CONVERSATION_IN_PAYLOAD`; источник не определяет порядок ревизий внутри пакета.

Загрузка файла: `multipart/form-data`, поле `file` содержит UTF-8 JSON; допускается полный конверт организаторов или голый массив записей. Для массива поле `group_id` обязательно. Для конверта берётся `data.dataset_group_id`; если поле multipart также передано, значения должны совпасть, иначе 409 `GROUP_MISMATCH`. В конверте проверяются `isSuccess`, `data.records`, `dataset_group_id`, `total_records`; расхождение заявленного количества с длиной массива — предупреждение `TOTAL_RECORDS_MISMATCH`, фактическое `received` равно длине массива.

Запись источника: обязательны строковые непустые `conversation_id`, `channel`, `language` и массив `transcript`. `audio_url` допускает отсутствие/null. Элемент транскрипта требует строковые `timestamp`, `speaker`, `text`; пустой текст сохраняется с предупреждением. Пустой транскрипт пропускается с ошибкой `EMPTY_TRANSCRIPT`. Битая реплика делает невалидной запись целиком, чтобы номера остальных реплик не сдвинулись. Неизвестные роли/каналы/языки сохраняются как строки с предупреждениями `UNKNOWN_ROLE`, `UNKNOWN_CHANNEL`, `UNKNOWN_LANGUAGE`. Неразобранная метка даёт `UNPARSEABLE_TIMESTAMP`, `offset_sec=null`, но не отклоняет запись.

`POST /imports/dataset` использует серверный `DATASET_URL`, меняя только параметр группы. В запросах/ответах API и логах импортирования этой ссылки нет. `unknown_system_phrases` может содержать исходный текст, поэтому является приватным содержимым рабочего приложения и не переносится в публичные примеры или телеметрию.

## 5. Разговоры и ревизии

```text
ConversationRef = {
  id: string,                   // внутренний ID логического разговора
  group_id: string,
  conversation_id: string,       // внешний ID источника
  revision_id: string,           // внутренний ID неизменяемой ревизии
  revision: integer              // начиная с 1
}
ConversationSummary = {
  ref: ConversationRef,          // текущая ревизия
  channel: string,
  language: string,
  message_count: integer,
  has_audio: boolean,
  latest_evaluation: EvaluationSummary | null,
  has_open_appeals: boolean,
  created_at: string,
  updated_at: string
}
ConversationRevision = {
  ref: ConversationRef,
  channel: string,
  language: string,
  message_count: integer,
  content_hash: string,
  created_at: string
}
ConversationDetail = {
  ref: ConversationRef,
  channel: string,
  language: string,
  transcript: Message[],
  audio_url: string | null,
  audio_offset_reliable: boolean,
  manual_review_reasons: string[],
  warnings: string[],
  created_at: string
}
Message = {
  id: integer,                  // неизменяемая позиция 1..N внутри revision_id
  timestamp: string,
  speaker: string,
  text: string,
  offset_sec: number | null,
  audio_offset_sec: number | null,
  phase: "pre_operator" | "client" | "hold" | "internal_consult" | "after_end",
  client_facing: boolean,
  system_event: string | null,
  flags: string[],
  duplicate_of_message_id: integer | null
}
```

`GET /conversations` фильтруется по `group_id`, `language`, `channel` (точное совпадение), `evaluation_status` (`not_evaluated|completed|manual_review|failed`), `has_gross_error` (boolean), `has_open_appeals` (boolean), `q` (поиск подстроки только во внешнем ID, без поиска по чувствительному транскрипту). Указанные фильтры оценки относятся к `latest_evaluation` текущей ревизии. `latest_evaluation` — последняя созданная оценка этой ревизии; задания без сохранённой оценки отражаются через `/jobs/{id}`. После импорта новой ревизии поле равно null до её оценки.

`GET /conversations/{id}` возвращает последнюю ревизию, если `revision_id` не передан. Переданный ID ревизии обязан принадлежать этому разговору, иначе 404. Для просмотра доказательств из оценки фронтенд всегда передаёт сохранённый `revision_id`. Список ревизий сортируется `revision DESC`.

`system_event=null` у несистемных сообщений; `unknown` у нераспознанной системной фразы. Известные коды: `escalation`, `identity_verified`, `connection_lost`, `operator_closed`, `client_left`, `client_ended`, `agent_joined`, `recording_started`, `recording_paused`, `recording_resumed`, `consult_initiated`, `consult_started`, `hold_start`, `hold_end`, `agent_left`, `transfer_to_support`, `language_changed`. Коды расширяются словарём данных.

Известные `flags`: `duplicate_of_prev`, `after_end`, `pii_masked`, `unknown_event`. Дубликаты остаются в массиве. `duplicate_of_message_id` — ID непосредственного предыдущего сообщения при совпадении роли и текста, иначе null.

`offset_sec` описывает время транскрипта, а не гарантированное положение в записи. `audio_offset_sec` возвращается только после проверки соответствия аудиошкале; иначе null. `audio_offset_reliable=false` при паузах записи или неразобранных метках; отсутствие этих признаков само по себе не доказывает надёжность. Аудиоссылка доступна только в карточке для воспроизведения; её нельзя писать в логи, аналитические события или публичные примеры.

## 6. Чек-листы

```text
CriterionType = "binary" | "scale" | "flag"
AnswerValue = boolean | number
AnswerOption = {
  value: AnswerValue,
  label: string,
  description: string,
  normalized?: number | null // в запросе по умолчанию null; в ответе поле всегда присутствует
}
Criterion = {
  id: string,
  name: string,
  description: string,
  section: string,
  answer_type: CriterionType,
  weight: number | null,
  options: AnswerOption[],
  na_allowed: boolean,
  na_condition: string | null
}
ChecklistDefinition = { name: string, description: string, criteria: Criterion[] }
CreateChecklistRequest = ChecklistDefinition
CreateVersionRequest = ChecklistDefinition & {
  expected_latest_version_id: string,
  activate?: boolean, // по умолчанию false
  expected_active_version_id?: string | null // обязателен при activate=true, включая явный null
}
Checklist = {
  id: string,
  name: string,
  description: string,
  latest_version_id: string,
  latest_version: integer,
  created_at: string
}
ChecklistVersion = {
  id: string,
  checklist_id: string,
  version: integer,
  definition: ChecklistDefinition,
  content_hash: string,
  is_active: boolean,
  created_at: string
}
ValidationReport = { valid: boolean, errors: ErrorDetail[], warnings: ErrorDetail[] }
ActivationResult = { active_version_id: string, previous_version_id: string | null }
```

Порядок критериев задаётся порядком массива. ID критерия уникален внутри версии, непустой, сохраняется при редактировании того же правила. У замены принципиально другим правилом — новый ID. Разрешён любой набор критериев, включая только флаги; пустой список запрещён. Название и описание правила непустые. Секция может быть пустой строкой, тогда это одна общая секция без названия.

Для `binary`: ровно варианты `true`/`false`, нормирование соответственно 1/0, положительный `weight`. Для `scale`: непустой список уникальных числовых значений, положительный `weight`, `normalized` в [0,1] у каждого варианта. Если для ступени scale поле `normalized` отсутствует или равно null, сервер подставляет `value / max_value`, где `max_value` — максимальное значение среди ступеней этого критерия. Для такой подстановки максимум должен быть положительным, а результат — попадать в [0,1]; иначе это ошибка правила. Явные значения normalized имеют приоритет и не перезаписываются. В сохранённой версии, снимке оценки и ответах нормирование scale всегда задано явно. `/checklists/validate` применяет те же правила подстановки без сохранения. Для `flag`: варианты `true`/`false`, `weight=null`, `normalized=null`; true означает наличие нарушения, false — отсутствие. N/A разрешается для любого типа только если `na_allowed=true` и непустое `na_condition`; у исходного флага N/A запрещён. Значения bool и number различаются строго: true не равно 1. NaN/Infinity запрещены.

`POST /checklists/validate`: структурно корректный запрос с ошибками правил получает 200, `valid=false` и пути ошибок; ошибочная JSON-структура/типы — 422. Создание с теми же ошибками всегда 422. Проверка ничего не сохраняет.

Создание чек-листа через `POST /checklists` создаёт версию 1, но не активирует её; автоматическая активация seed при первом запуске описана в разделе 3. Создание версии сохраняет полный новый снимок, увеличивает номер на 1 и обновляет краткую карточку `Checklist`. Если `expected_latest_version_id` устарел — 409 `VERSION_CONFLICT`. При `activate=true` новая версия также активируется в этой же транзакции. Для этого запрос явно передаёт `expected_active_version_id` (null, если активной версии нет); отсутствие поля — 422, несовпадение с текущей активной версией — 409 `VERSION_CONFLICT`. При любом конфликте версия не создаётся и активная версия не меняется. При `activate=false` поле ожидаемой активной версии не используется. Ранее сохранённые версии неизменяемы, `is_active` — вычисляемое состояние, а не часть снимка правил. Редактирование имени или описания также создаёт версию.

В сервисе одна активная версия для новых запусков. Активация сравнивает `expected_active_version_id` с текущим значением в транзакции; конфликт — 409. Повторная активация уже активной версии с актуальным expected ID допустима и ничего не дублирует. Старые оценки, выполняемые задания и кеш правил не меняются. Фронтенд получает исходную конфигурацию с сервера, не зашивает восемь критериев в код.

## 7. Запуск и задания оценки

```text
EvaluationRequest = {
  revision_ids?: string[] | null, // 1..1000 уникальных внутренних ID ревизий; по умолчанию null
  group_id?: string | null,       // текущие ревизии всех разговоров группы; по умолчанию null
  checklist_version_id?: string | null, // по умолчанию текущая активная
  force?: boolean               // по умолчанию false
}
JobStatus = "queued" | "running" | "completed" | "failed"
Job = {
  id: string,
  status: JobStatus,
  checklist_version_id: string,
  is_demo: boolean,
  provider: string,
  total: integer,
  processed: integer,
  succeeded: integer,
  failed: integer,
  manual_review_count: integer,
  progress_percent: number,
  items: JobItem[],
  error: OperationError | null,
  created_at: string,
  started_at: string | null,
  finished_at: string | null
}
JobItem = {
  revision_id: string,
  status: JobStatus,
  evaluation_id: string | null,
  error: OperationError | null
}
OperationError = { code: string, message: string, retryable: boolean }
```

Один разговор и пакет используют один маршрут. Должно быть задано ровно одно ненулевое поле: `revision_ids` или `group_id`; оба сразу либо ни одного — 422. Пустая группа, пустой/повторный список или список длиннее 1000 — 422. Для оценки всей группы фронтенд отправляет `group_id`; сервер фиксирует текущие ревизии всех её разговоров в момент создания задания, поэтому последующий импорт не подменяет вход задания. Группа без разговоров — 404 `NOT_FOUND`. Явные `revision_ids` по-прежнему позволяют оценить выбранные, в том числе исторические, ревизии. Существование всех ревизий и версии проверяется до создания задания; неверный ID — 404. Версия и настройки провайдера/расчёта фиксируются в момент постановки. Отсутствующая активная версия — 422; ненастроенный настоящий провайдер — 503. Число критериев и допустимые ответы определяются выбранной версией.

Фронтенд опрашивает `/jobs/{id}` раз в секунду и прекращает на терминальном статусе. `processed=succeeded+failed`; `progress_percent=100*processed/total`. Сохранённая валидная оценка с необходимостью ручной проверки считается `succeeded`, отдельно увеличивая `manual_review_count`. Невалидный ответ модели после повторов — ошибка элемента, не успешная оценка. Если доступен диагностический результат, `evaluation_id` может быть задан и у failed.

Задание `completed` только если все элементы успешно завершены. После обработки всех элементов при хотя бы одной ошибке — `failed`; остальные результаты сохраняются и доступны. Сбой одного элемента не отменяет остальные. При остановке/перезапуске все незавершённые элементы переводятся в failed, `error.code=INTERRUPTED_BY_RESTART`; готовые остаются. Отмена задания в v1 не предусмотрена.

`force=false`: результаты неизменённых критериев могут переиспользоваться только для той же ревизии, определения критерия, модели, промпта и влияющих настроек. Изменение только веса приводит к новому расчёту без вызова модели, но сохраняет новую оценку и ссылку на новую версию. `force=true` вызывает модель для всех критериев. Повторный POST запуска создаёт отдельное задание, поэтому после сетевой неопределённости фронтенд не повторяет автоматически POST, если уже получил ID.

## 8. Оценки, доказательства и баллы

```text
EvaluationStatus = "completed" | "manual_review" | "failed"
EvaluationSummary = {
  id: string,
  conversation: ConversationRef,
  checklist_version_id: string,
  status: EvaluationStatus,
  is_demo: boolean,
  original_total: number | null,
  final_total: number | null,
  gross_error: boolean | null,
  has_open_appeals: boolean,
  created_at: string,
  scoring_policy: ScoringPolicy | null
}
Answer = { status: "answered" | "not_applicable" | "invalid", value: AnswerValue | null }
MessageRange = { start_id: integer, end_id: integer }
Evidence = { message_id: integer, text: string, speaker: string, timestamp: string, phase: string }
CriterionResult = {
  criterion_id: string,
  answer: Answer,
  rationale: string,
  evidence_message_ids: integer[],
  evidence: Evidence[],
  checked_range: MessageRange | null,
  expected_action: string | null,
  na_reason: string | null,
  manual_review: boolean,
  manual_review_reasons: string[],
  warnings: string[],
  reused: boolean,
  reused_from_evaluation_id: string | null,
  original_weight: number | null,
  normalized_answer: number | null,
  effective_weight: number | null,
  weighted_points: number | null,
  contribution: number | null
}
SectionResult = {
  section: string,
  applicable_weight: number,
  weighted_points: number | null,
  completion_percent: number | null,
  contribution: number | null
}
FlagResult = { criterion_id: string, value: boolean | null }
ResultSnapshot = {
  status: EvaluationStatus,
  criteria: CriterionResult[],
  total: number | null,
  total_before_override: number | null,
  total_reason: string | null,
  applicable_weight: number,
  sections: SectionResult[],
  flags: FlagResult[],
  gross_error: boolean | null,
  manual_review_reasons: string[]
}
Usage = {
  provider: string,
  model: string | null,
  prompt_version: string,
  duration_ms: integer,
  calls: integer,
  input_tokens: integer | null,
  output_tokens: integer | null,
  cost: number | null,
  currency: string | null
}
Evaluation = {
  id: string,
  conversation: ConversationRef,
  checklist_version_id: string,
  checklist_snapshot: ChecklistDefinition,
  scoring_policy: ScoringPolicy,
  is_demo: boolean,
  original: ResultSnapshot,
  final: ResultSnapshot,
  final_revision: integer,
  applied_decision_ids: string[],
  usage: Usage,
  created_at: string,
  updated_at: string
}
```

GET списка оценок: фильтры `conversation_id` (внутренний ID), `revision_id`, `checklist_version_id`, `status`, `is_demo`, пагинация. `status` в Summary — текущий `final.status`, `gross_error` — текущий `final.gross_error`. Исторические оценки не скрываются при повторном запуске.

`EvaluationSummary.scoring_policy` — сохранённая политика конкретной оценки, такая же, как в `Evaluation.scoring_policy`. Она доступна в списке оценок, в `ConversationSummary.latest_evaluation` и в обеих сводках сравнения. Для отображения точности `original_total`/`final_total` используется эта политика, а не текущая политика `/api/health`: изменение настроек сервера не меняет сводки старых оценок. Поле добавлено совместимо: при чтении старой сводки без поля оно считается `null`. `null` означает неизвестную политику и не подменяется настройками текущего сервера; у оценок, сохранённых действующим API, политика присутствует.

`answered` требует значение выбранной ступени/boolean. `not_applicable` требует `value=null`, разрешённый N/A и непустой `na_reason`. `invalid` используется сервером для диагностического результата без допустимого ответа; его нельзя отправлять в решении апелляции. Невалидный ответ по применимому весовому критерию делает общий балл null. Неуверенность модели при валидном ответе может дать `manual_review` и рассчитанный балл, а не N/A.

Порядок `criteria` совпадает со снимком чек-листа. Обоснование по умолчанию на русском. `evidence` сервер собирает из неизменённого транскрипта по ID, а не из текста цитат модели. Все переданные ID и границы диапазона существуют в `conversation.revision_id`; обе границы включены, `start_id<=end_id`. Для модельного вывода о пропуске действия необходимы `checked_range` и непустой `expected_action`; нельзя создавать цитату отсутствующего действия. Решение человека может не содержать доказательства или диапазон, как описано в разделе 9. N/A требует причины, но не выдуманного доказательства. `invalid` не содержит выдуманных ссылок. При подтверждениях только из неклиентской фазы результат предупреждает о необходимости ручной проверки.

Пусть W — сумма весов применимых весовых критериев, w — исходный вес, r — нормированный ответ. `weighted_points=w*r`, `effective_weight=100*w/W`, `contribution=100*w*r/W`. N/A: `original_weight=w`, остальные четыре числовых поля результата — null. Для флага все пять полей веса/баллов — null. Если W=0, итог и вклад null с причиной; флаги остаются доступными. При неполной валидной оценке общий итог и вклад в общий результат null; локальные валидные `weighted_points` можно показывать как предварительные.

`sections.completion_percent=100*sum(weighted_points_section)/sum(applicable_weights_section)` — выполнение внутри секции. `sections.contribution=100*sum(weighted_points_section)/W` — вклад в общий результат. При нулевом весе секции её процент null, вклад 0 при W>0; при W=0 вклад null. При недостающем валидном ответе секция имеет `weighted_points=null`, процент null. Фронтенд подписывает эти показатели по-разному.

`flags` содержит каждый criterion типа flag. `gross_error` — true если хотя бы один флаг true; false если флаги есть и все false либо список флагов пуст; null если ни одного true и хотя бы один неизвестен/N/A. Наименование «грубые ошибки» для исходного чек-листа является названием критерия; логика не привязана к его ID.

`total_before_override` всегда содержит округлённый итог до политики обнуления либо null. `total` совпадает с ним, кроме включённого `gross_error_zeroes_total` и истинного флага — тогда 0. Если применимых весов нет или валидных ответов недостаточно, оба итога null даже при нарушении. `total_reason=null` при обычном рассчитанном итоге; иначе русское пояснение отсутствия/изменения итога.

`original` неизменяем. `final` — его копия с последовательно применёнными решениями, первоначальный `final_revision=0`. Используется политика исходной оценки. Стоимость/токены включают все вызовы и повторы; неизвестные расходы null. `calls=0` при полном переиспользовании; затраты на старые оценки повторно не прибавляются. Fake помечается demo, не выдаётся за измеренную точность модели. Сырой ответ модели хранится на сервере для аудита, в обычный ответ API не входит.

Начиная с `cqa-v9`, настоящие провайдеры запрашивают каждый критерий отдельно с полным транскриптом. Поэтому `usage.calls` может быть больше одного без ошибок и повторов. Ответ оценки по-прежнему содержит все требуемые критерии; окончательная ошибка отдельного вызова не выдаётся за успешную частичную оценку. FakeLLM сохраняет пакетный режим. Публичные поля, типы и смысл `calls` не изменились.

## 9. Апелляции

```text
CreateAppealRequest = { evaluation_id: string, criterion_id: string, comment: string }
AppealDecisionRequest = {
  action: "confirm" | "change",
  reason: string,
  expected_final_revision: integer,
  new_answer?: Answer | null,
  rationale?: string | null, // для change при отсутствии/null используется reason
  evidence_message_ids?: integer[], // по умолчанию []
  checked_range?: MessageRange | null, // по умолчанию null
  expected_action?: string | null,
  na_reason?: string | null
}
AppealDecision = {
  id: string,
  action: "confirm" | "change",
  reason: string,
  before: CriterionResult,
  after: CriterionResult,
  resulting_final_revision: integer,
  created_at: string
}
Appeal = {
  id: string,
  evaluation_id: string,
  criterion_id: string,
  comment: string,
  status: "open" | "resolved",
  opened_at_final_revision: integer,
  decision: AppealDecision | null,
  created_at: string,
  resolved_at: string | null
}
AppealDecisionResult = { appeal: Appeal, evaluation: Evaluation }
```

Комментарий и причина после trim непустые. Апелляция допустима для весового критерия или флага из снимка исходной оценки, включая критерий с невалидным ответом. Одна открытая апелляция на пару `(evaluation_id,criterion_id)`; повтор — 409 `DUPLICATE_OPEN_APPEAL`. После закрытия допускается новая апелляция, история сохраняется.

`GET /appeals`: фильтры `evaluation_id`, `status`, пагинация. `confirm` подтверждает текущий финальный ответ на момент решения (если ранее пересматривался, исходная модельная оценка отдельно остаётся в `original`); новые поля ответа должны отсутствовать/null, список доказательств — отсутствовать/пустой. Невалидный ответ нельзя подтвердить как валидный — он останется invalid. `change` требует `new_answer` и непустой `reason`; если `rationale` отсутствует или null, сервер сохраняет в качестве обоснования `reason`. Явный rationale должен быть непустым. `evidence_message_ids` и `checked_range` для решения человека необязательны: отсутствие доказательств и диапазона добавляет предупреждение в `after.warnings`, но не препятствует решению и пересчёту. Если ссылки или диапазон переданы, они всё равно проверяются по сохранённой ревизии; несуществующие ID и неверные границы — 422. Для N/A по-прежнему обязательна `na_reason` и разрешение в критерии. По умолчанию отсутствующий список доказательств — `[]`, остальные nullable поля — null.

При `change` возможен N/A ↔ применимый ответ только по сохранённой версии чек-листа. `expected_final_revision` обязан совпасть с оценкой; иначе 409 `VERSION_CONFLICT` и фронтенд заново загружает её. Решение и изменение `final` выполняются одной транзакцией, версия увеличивается на 1, пересчитываются секции, флаги и итог. Ручной пересмотр снимает причину ручной проверки конкретного критерия, но не скрывает независимые проблемы других критериев/качества транскрипта. Повторное решение по закрытой апелляции всегда 409 `APPEAL_ALREADY_RESOLVED`. `before` и `after` сохраняются неизменяемо. Подача и решение — две самостоятельные UI-операции.

## 10. Сравнение оценок

`GET /evaluations/compare?left_id=...&right_id=...` только читает две существующие оценки, не вызывает модель и не создаёт задания. Оценки должны принадлежать одной ревизии разговора, иначе 409 `INCOMPARABLE_EVALUATIONS`. Разные версии чек-листа допустимы; направление delta — справа минус слева. Сравнивается текущий `final`; номера финальных ревизий возвращаются для воспроизводимости.

```text
EvaluationComparison = {
  conversation: ConversationRef,
  left: EvaluationSummary,
  right: EvaluationSummary,
  left_final_revision: integer,
  right_final_revision: integer,
  total_delta: number | null,
  criteria: CriterionComparison[]
}
CriterionComparison = {
  criterion_id: string,
  change: "unchanged" | "added" | "removed" | "definition_changed" | "weight_changed",
  left_definition: Criterion | null,
  right_definition: Criterion | null,
  left_result: CriterionResult | null,
  right_result: CriterionResult | null,
  contribution_delta: number | null
}
```

Сначала критерии правой версии в её порядке, затем удалённые в порядке левой. Если определение и вес менялись вместе, `change=definition_changed`; оба определения доступны для детального отображения. Даже при `unchanged` ответ может отличаться после force/апелляции. Для добавленного/удалённого нет второго результата; delta null, а не сравнение с выдуманным нулём. Любой null-итог/вклад даёт null-delta.

## 11. История

```text
HistoryEvent = {
  id: string,
  event_type: string,
  entity_type: "import" | "conversation" | "checklist_version" | "evaluation" | "appeal",
  entity_id: string,
  conversation_id: string | null, // внутренний ID
  evaluation_id: string | null,
  appeal_id: string | null,
  checklist_version_id: string | null,
  decision_id: string | null,
  final_revision: integer | null,
  summary: string,
  actor: "system" | "demo_operator" | "demo_reviewer",
  created_at: string
}
```

Фильтры `/history`: `conversation_id`, `evaluation_id`, `appeal_id`, `checklist_version_id`, `event_type`, пагинация. Все фильтры совмещаются через AND. Известные типы событий: `dataset_imported`, `conversation_created`, `conversation_revised`, `checklist_version_created`, `checklist_version_activated`, `evaluation_created`, `appeal_created`, `appeal_resolved`. Повторный неизменённый импорт не создаёт события новой ревизии. История append-only; авторы `demo_*` обозначают действие UI без установленной личности, а не подтверждённого пользователя.

Текст summary содержит безопасное описание действия, но не транскрипт, аудиоссылку, секреты и сырой ответ модели. Подробности решения доступны через `appeal_id`/`decision_id`, исходная и финальная оценки — через `evaluation_id`.

## 12. Порядок подключения фронта

1. GET health: показать demo/готовность, получить активную версию.
2. Импортировать группу либо файл; показать ошибки/предупреждения, затем список разговоров.
3. Открыть карточку; сохранить `ref.id` и `ref.revision_id`.
4. Запустить оценку нужных ревизий или всей группы по `group_id`, сохранить job ID, опрашивать задание.
5. По `evaluation_id` загрузить обе оценки и снимок правил; доказательства раскрывать в конкретной ревизии.
6. Подать апелляцию. Для решения получить свежий `final_revision`, затем отправить отдельный запрос с причиной.
7. В редакторе загрузить версию, проверить definition, сохранить новую версию с expected ID. Для одновременной активации передать `activate=true` и текущий `expected_active_version_id` из health либо вызвать отдельный маршрут активации. Для сравнения запустить новую оценку, затем вызвать compare.

Точные примеры HTTP-ответов генерируются `backend/scripts/gen_api_examples.py` через FakeLLM из синтетических фикстур, без настоящих диалогов и аудиоссылок. Доступность и текущий режим сервера проверяются через `/api/health`.

## Изменения

- 2026-11-07: первоначальный проект API v1 на контрольной точке раздела 1. Предыдущего опубликованного контракта не было. BREAKING-изменений нет.
- 2026-11-07: пользователь принял контракт с дополнениями: автоматические создание/активация seed v1, запуск по `group_id` с исключающим выбором `revision_ids`, атомарное создание/активация версии, нормирование scale по умолчанию и необязательные обоснование/доказательства ручного изменения. Для атомарной активации добавлен `expected_active_version_id`, сохраняющий существующую проверку конфликтов. Ослабление обязательности полей и переход `revision_ids` к одному из двух селекторов явно согласованы пользователем.
- 2026-11-07: по запросу фронтенда добавлено `EvaluationSummary.scoring_policy` — политика из сохранённой оценки для точного отображения старых итогов после изменения настроек сервера. Отсутствующее поле старой сводки трактуется как `null` (неизвестно), без подстановки текущего health. Существующие поля и маршруты не изменены.
- После начала реализации допускаются только добавления. Изменение существующего поля, типа, смысла или маршрута требует отдельного предложения BREAKING и явного согласия человека до реализации.
- При обновлении Python/Pydantic опубликованные имена компонентов OpenAPI `ChecklistDefinition-Input` и `ChecklistDefinition-Output` и ссылки на них сохраняются: входные тела используют Input, сохранённые/возвращаемые определения — Output. Их текущие одинаковые формы данных не меняются при объединении схем генератором. Описания ответов HTTP 413 и 422 в OpenAPI зафиксированы как `Request Entity Too Large` и `Unprocessable Entity`, независимо от формулировок стандартной библиотеки Python; коды и конверт ошибок остаются прежними.
