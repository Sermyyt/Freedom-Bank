# CQA — Conversation Quality Analytics

Оценка качества разговоров операторов по изменяемому чек-листу — с доказательствами, апелляциями и историей решений.

[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](backend/requirements.txt)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](backend/requirements.txt)
[![Без сборки фронтенда](https://img.shields.io/badge/frontend-%D0%B1%D0%B5%D0%B7_%D1%81%D0%B1%D0%BE%D1%80%D0%BA%D0%B8-455A64)](frontend/package.json)
[![Тесты: 493 backend + 123 frontend](https://img.shields.io/badge/tests-493_backend_%2B_123_frontend-455A64)](docs/DEVELOPMENT.md#проверка-команд-быстрого-старта)

[Быстрый старт](#быстрый-старт) · [Цифры](#цифры) · [API](#api) · [Документация](#документация)

## Зачем

В кейсе Freedom Broker нужно проверять качество разговоров операторов, даже когда критерии оценки меняются. CQA превращает транскрипт в разбор по чек-листу: проверяющий видит ответ, обоснование и сообщения, на которые опиралась модель, а затем может оспорить результат.

## Возможности

- **Доказательства по ID сообщений:** переход от оценки к конкретной реплике с сохранением исходного транскрипта.
- **Фазы звонка:** удержание и внутренняя консультация отмечены как «клиент не слышал»; сведения от коллеги не приравниваются к ответу клиенту.
- **Апелляции:** решение человека сохраняется отдельно от исходной оценки модели, с причиной и историей.
- **Версии чек-листа:** критерий можно заменить без изменения кода, сравнить оценки и переиспользовать подходящие результаты.
- **Оценка всей группы:** пакетный запуск, прогресс и результаты задания; повторное чтение задания без нового запуска.
- **RU / KZ / EN:** работа с русскими, казахскими и английскими транскриптами.
- **Честные статусы:** «Демо» для синтетических оценок и «Нужна ручная проверка» для отмеченных неоднозначностей.

## Как это работает

```mermaid
flowchart LR
    A[Импорт разговоров] --> B[Фазы и события]
    B --> C[Оценка моделью по критериям]
    C --> D[Проверка ответа и доказательств]
    D --> E[Расчёт баллов кодом]
    E --> F[Апелляции и история]
```

**Модель выбирает ответ; баллы и округление считает сервер.** Проверка формата и доказательств не гарантирует смысловую правильность ответа — решение остаётся доступным для проверки человеком.

## Цифры

Измерения конкретных запусков: `cqa-v9`, `gpt-4.1-mini`, чек-лист версии 5, параллелизм 4. Повторяемость в последней строке относится к более раннему `cqa-v5`.

| Что измерено | Результат | Источник |
| --- | --- | --- |
| Полный набор DEV | **65/65** разговоров обработаны | [DATA_NOTES](docs/DATA_NOTES.md#база-защиты-и-живая-замена-критерия-2026-11-07) |
| Время полного DEV | **636,954 с** (≈ 10 мин 37 с) | [DATA_NOTES](docs/DATA_NOTES.md#база-защиты-и-живая-замена-критерия-2026-11-07) |
| Расчётная стоимость | **$0,812968** за набор; **≈ $0,0125** за разговор | [PITCH_FACTS](docs/PITCH_FACTS.md) |
| Переоценка после замены критерия | **4,964 с**, **1 вызов модели**, 7 результатов переиспользованы | [PITCH_FACTS](docs/PITCH_FACTS.md) |
| Историческая повторяемость `cqa-v5` | **440/512 ответов — 85,9375%** | [PITCH_FACTS](docs/PITCH_FACTS.md) |

Стоимость рассчитана по токенам; фактическое списание неизвестно. **65/65 — завершение обработки, а не точность.** Повторяемость также не равна точности. По последнему [аудиту](docs/PITCH_FACTS.md) человеческой gold-разметки нет, поэтому точность относительно неё ещё не измерена.

## Быстрый старт

Нужны Git и Python 3.11+. Демо запускается без ключа модели; сборка фронтенда и установка Node.js для работы приложения не нужны.

### Windows PowerShell

```powershell
git clone https://github.com/Sermyyt/Freedom-Bank.git
Set-Location Freedom-Bank
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
$env:LLM_PROVIDER = 'fake'
Set-Location backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### macOS / Linux

```bash
git clone https://github.com/Sermyyt/Freedom-Bank.git
cd Freedom-Bank
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
export LLM_PROVIDER=fake
cd backend
../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Откройте **[интерфейс](http://127.0.0.1:8000/)** или [Swagger](http://127.0.0.1:8000/docs). Новая база пустая: загрузите свой JSON через блок импорта файла в интерфейсе и запустите оценку группы. Для массива записей укажите группу; формат описан в [контракте](docs/API_CONTRACT.md). Реальные разговоры в репозиторий не включены. Остановка сервера — `Ctrl+C`; решения проблем запуска — в [руководстве](docs/DEVELOPMENT.md).

### Настоящая модель

Создайте `.env` в корне проекта по [`.env.example`](.env.example). Заполните `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`; при необходимости — `LLM_BASE_URL`. Поддерживаемые провайдеры и требования к модели описаны в [DEVELOPMENT](docs/DEVELOPMENT.md#настоящая-модель).

Остановите демо. В новой консоли перейдите в `backend/` и запустите сервер с явной загрузкой `.env`:

```powershell
# Windows PowerShell, из backend/
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file ../.env
```

```bash
# macOS / Linux, из backend/
../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file ../.env
```

Переменные текущего процесса имеют приоритет над `.env`: демо-настройка из старой консоли иначе останется активной. Секреты вводятся только на сервере.

## Настройка

Значения по умолчанию из [конфигурации](backend/app/config.py), без загрузки `.env`. Пример файла может задавать другие значения.

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `LLM_PROVIDER` | Провайдер оценки | `fake` |
| `LLM_MODEL` | Модель | Не задана |
| `LLM_API_KEY` | Ключ провайдера | Не задан |
| `LLM_BASE_URL` | Адрес API провайдера | Не задан |
| `DATABASE_PATH` | База SQLite | `data/cqa.db` от корня проекта |
| `DATASET_URL` | Серверный источник для импорта группы | Не задан |
| `CORS_ORIGINS` | Разрешённые сторонние origin через запятую | Пустой список |
| `LLM_MAX_CONCURRENCY` | Одновременно обрабатываемые разговоры | `2` |
| `LLM_TIMEOUT` | Тайм-аут попытки, секунды | `60` |
| `LLM_MAX_ATTEMPTS` | Максимум попыток вызова | `3` |
| `LLM_MAX_OUTPUT_TOKENS` | Лимит токенов ответа | `8192` |
| `SCORE_ROUNDING` | Способ округления | `half_up` |
| `SCORE_DECIMALS` | Знаки после запятой | `2` |
| `GROSS_ERROR_ZEROES_TOTAL` | Обнуление итога при грубом нарушении | `false` |
| `RATIONALE_LANGUAGE` | Язык обоснований | `ru` |
| `DATASET_TIMEOUT` | Тайм-аут загрузки набора, секунды | `60` |
| `MAX_UPLOAD_BYTES` | Максимальный размер загрузки, байты | `20971520` |
| `MAX_QUEUED_JOBS` | Лимит очереди заданий | `32` |

## Структура проекта

```text
Freedom-Bank/
├── backend/         # FastAPI, SQLite, оценка, скрипты и тесты
├── frontend/        # HTML, CSS и JavaScript без сборки
├── docs/            # Контракт, измерения и руководства
├── data/            # Локальные данные и база; создаются при работе, вне Git
├── .env.example     # Пример серверных настроек
└── README.md        # Обзор и быстрый старт
```

## API

| Маршрут | Назначение |
| --- | --- |
| `GET /api/health` | Режим работы, готовность и активный чек-лист |
| `POST /api/imports/file` | Импорт JSON-файла |
| `GET /api/conversations` | Разговоры и фильтры |
| `POST /api/evaluations` | Запуск оценки группы или выбранных ревизий |
| `GET /api/jobs/{id}` | Прогресс и результат задания |
| `POST /api/appeals/{id}/decision` | Подтверждение или изменение оценки по апелляции |

Все маршруты и схемы: [API_CONTRACT](docs/API_CONTRACT.md) · [OpenAPI](docs/openapi.json) · [Swagger `/docs`](http://127.0.0.1:8000/docs) на запущенном сервере.

## Тесты и качество

Бэкенд, из `backend/`:

```powershell
# Windows PowerShell
..\.venv\Scripts\python.exe -m pytest
```

```bash
# macOS / Linux
../.venv/bin/python -m pytest
```

Фронтенд, из корня проекта; нужен Node.js:

```text
node --test "frontend/tests/*.test.mjs"
```

В наборе **493 теста бэкенда и 123 теста фронтенда**. В чистой копии без DEV: **491 passed / 2 skipped**, фронтенд — **123 passed**; это результаты локальной [проверки команд](docs/DEVELOPMENT.md#проверка-команд-быстрого-старта), а не статус CI. Тесты не вызывают настоящую модель. Разбор смысловых ошибок — [QUALITY_NOTES](docs/QUALITY_NOTES.md), подготовка к защите и восстановление — [RUNBOOK](docs/RUNBOOK.md).

## Ограничения

- Демо создаёт синтетические ответы для проверки процесса, а не оценивает смысл разговора.
- Точность не подтверждена человеческой разметкой; модель ошибается, особенно в неоднозначных случаях. Отметка ручной проверки не выявляет все ошибки.
- Точное соответствие времени транскрипта аудиозаписи не установлено; переход к реплике не означает точную перемотку аудио.
- Сервис предназначен для локальной демонстрации без авторизации. Запускайте один серверный процесс; эксплуатационные ограничения описаны в [DEVELOPMENT](docs/DEVELOPMENT.md).

## Безопасность и данные

`.env`, `data/`, базы SQLite и исходные документы организаторов исключены из Git. Реальные разговоры не публикуются; примеры API используют синтетические данные. Ключи и адрес источника остаются на сервере и не передаются во фронтенд. Правила работы с данными — в [AGENTS.md](AGENTS.md).

## Документация

- [DEVELOPMENT](docs/DEVELOPMENT.md) — подробный запуск, настройки, скрипты, диагностика и статус проверок.
- [RUNBOOK](docs/RUNBOOK.md) — защита, импорт, повтор заданий, резервная копия и восстановление.
- [PITCH_FACTS](docs/PITCH_FACTS.md) — проверенные факты для выступления.
- [DATA_NOTES](docs/DATA_NOTES.md) — аудит данных, условия измерений, время и стоимость.
- [QUALITY_NOTES](docs/QUALITY_NOTES.md) — смысловые расхождения и ограничения оценки.
- [API_CONTRACT](docs/API_CONTRACT.md) — маршруты, схемы и правила совместимости.
- [Примеры API](docs/examples/) и [OpenAPI](docs/openapi.json) — синтетические ответы и машиночитаемая схема.
- [DECISIONS](docs/DECISIONS.md) — принятые решения и уточнения требований.
- [BACKEND_SPEC](docs/BACKEND_SPEC.md) — исходное ТЗ; уточнения фиксируются в DECISIONS.
- [FRONTEND_SPEC](docs/FRONTEND_SPEC.md), [FRONTEND_NOTES](docs/FRONTEND_NOTES.md), [FRONTEND_REQUESTS](docs/FRONTEND_REQUESTS.md) — требования, состояние и запросы интерфейса.
- [WORK_LOG](docs/WORK_LOG.md) — история реализации и проверок.

## Лицензия

Лицензия будет выбрана командой.

## In English

CQA reviews operator conversations against a versioned, editable checklist for the Freedom Broker case.<br>
Each answer links to message evidence; call phases distinguish customer-facing dialogue from internal consultation.<br>
The model selects answers, while the server calculates scores and rounding.<br>
Appeals preserve the original evaluation and record human decisions separately.<br>
Python and FastAPI serve a frontend with no build step; demo mode runs without an API key.<br>
Human-labelled accuracy has not been measured; ambiguous results still need human review.
