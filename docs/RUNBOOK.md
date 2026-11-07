# Защита и 23-й час — PowerShell

Текущий выбранный режим импорта: **из локального файла** (прямой DATASET_URL пока не настроен). Поэтому preflight намеренно показывает `FAIL dataset_ready`; остальные проверки должны быть OK. Для контрольной группы используйте файловый импорт из раздела 3, затем оценку и наблюдение из раздела 2. Если источник настроите позже, прямой импорт станет доступен после перезапуска сервера.

Все команды ниже выполняются из корня репозитория. Вторая консоль нужна для API-команд, пока сервер работает в первой. Не вставляйте ключ модели или ссылку организаторов в команды, чат или Git. Настройки находятся в локальном игнорируемом `.env`; содержимое файла не выводить. Для прямого импорта требуется `DATASET_URL`, для настоящей оценки — `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`.

## 1. Перед защитой

Откройте PowerShell в корне проекта:

```powershell
$ErrorActionPreference = 'Stop'
$pythonPath = (Resolve-Path .venv/Scripts/python.exe).Path
$api = 'http://127.0.0.1:8000'
$env:PYTHONDONTWRITEBYTECODE = '1'
```

В первой консоли запустите сервер (если он уже работает, второй экземпляр не запускать):

```powershell
$env:LLM_PROVIDER = 'openai'
$env:LLM_MODEL = 'gpt-4.1-mini'
$env:LLM_MAX_CONCURRENCY = '8'
& $pythonPath -B -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --env-file .env
```

Не использовать `--reload` или несколько `--workers` во время заданий. Значения переменных процесса имеют приоритет над `.env`.

Рекомендуется конкуренция **8**: проверено 16 разговоров DEV с `force=true`, 64.606 с, без 429, тайм-аутов и ошибок. Ориентир для 65 разговоров — **около 4.4 минуты** по линейной оценке; полный DEV при 8 не измерялся, закладывайте запас. При появлении 429 сначала вернитесь к 4, при необходимости — к 1 по разделу 3. Прежний измеренный полный DEV при 4 занял 636.954 с. Условия и ограничения расчёта — DATA_NOTES.

Во второй консоли выполните начальные переменные выше и проверку:

```powershell
& $pythonPath -B backend/scripts/preflight.py --expected-dev-count 65 --expected-prompt-version cqa-v9
if ($LASTEXITCODE -ne 0) { Write-Warning 'Есть FAIL: разберите их перед защитой.' }
```

Preflight только читает данные. Флаги выше отдельно требуют базу защиты: 65 разговоров DEV и замороженный `cqa-v9`; без этих необязательных флагов проверяется согласованность с текущим сервером, а не конкретная база защиты. `FAIL provider` с `DEMO` означает синтетическую оценку; `evaluation_ready` — готовность настроек, а не пробный платный запрос. `dataset_ready` проверяет наличие настройки источника, не доступность ссылки. При `FAIL dataset_ready` задайте `DATASET_URL` локально в `.env` и перезапустите сервер после завершения заданий либо используйте импорт файла из раздела 3. Уже импортированный DEV от этой настройки не зависит. `DEV evaluations` считает только текущие ревизии, активную версию чек-листа, текущие prompt/provider/model и реальные завершённые оценки. `manual_review` считается завершённой оценкой, но требует внимания человека.

Откройте в браузере `http://127.0.0.1:8000/`, нажмите **Ctrl+Shift+R**, выберите DEV и один разговор. Убедитесь, что список, карточка, доказательства и пометка настоящего провайдера отображаются. Preflight проверяет HTTP и HTML `/`, не отрисовку JavaScript. Перед сменой активного чек-листа зафиксируйте его ID:

```powershell
$health = (Invoke-RestMethod "$api/api/health").data
$originalVersion = $health.active_checklist_version_id
New-Item -ItemType Directory -Force data/runtime | Out-Null
$originalVersion | Set-Content -Encoding UTF8 data/runtime/original-version.txt
```

### Резервная копия SQLite

Дождитесь окончания текущих заданий, чтобы снимок содержал законченные оценки. SQLite backup API допускает работающий сервер и учитывает WAL; не копируйте один открытый `cqa.db` через проводник. По умолчанию база — `data/cqa.db`; если сервер использует другой `DATABASE_PATH`, явно укажите тот же файл в `$databasePath`.

```powershell
$databasePath = (Resolve-Path data/cqa.db).Path
$backupDir = Join-Path $env:LOCALAPPDATA 'CQA/backups'
New-Item -ItemType Directory -Force $backupDir | Out-Null
$backupPath = Join-Path $backupDir ('cqa-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.db')
& $pythonPath -B backend/scripts/database_backup.py backup --database $databasePath --output $backupPath
if ($LASTEXITCODE -ne 0) { throw 'Резервная копия не подтверждена' }
Write-Host "Копия: $backupPath"
```

Утилита использует SQLite backup API и проверяет `integrity_check`; существующий файл назначения не перезаписывает. Команда совместима с Windows PowerShell 5.1 и путями с пробелами. Доверяйте копии только после `Backup OK` и кода выхода 0. Копия вне OneDrive и Git, содержит реальные разговоры и результаты. Сохраните её путь. Отдельно сохраните локальные `data/raw/` и заполненные `data/gold/` в защищённое место, если нужна возможность восстановить также исходные файлы и человеческую разметку. Ключи в эту процедуру не входят.

## 2. 23-й час: импорт и оценка контрольной группы

```powershell
New-Item -ItemType Directory -Force data/runtime, data/raw | Out-Null
```

Укажите точный ID группы, выданный организаторами; слово CONTROL ниже — пример. Не изменяйте DEV ради контрольного набора.

```powershell
$groupId = 'CONTROL'
& $pythonPath -B backend/scripts/preflight.py --expected-dev-count 65 --expected-prompt-version cqa-v9
$importBody = @{ group_id = $groupId } | ConvertTo-Json -Compress
$importReport = (Invoke-RestMethod -Method Post -Uri "$api/api/imports/dataset" -ContentType 'application/json' -Body $importBody).data
$importReport | Select-Object received, created, revised, unchanged, skipped
Write-Host ('Ошибок записей: ' + @($importReport.errors).Count)
```

`skipped` и ошибки записей требуют разбора: успешный HTTP сам по себе не означает принятие всех разговоров. Повторный импорт той же группы идемпотентен; изменённые данные создают новые ревизии. При ошибке источника перейдите к импорту файла, не запускайте оценку пустой группы.

Запуск и немедленное сохранение ID задания:

```powershell
$activeVersion = (Invoke-RestMethod "$api/api/health").data.active_checklist_version_id
$body = @{ group_id = $groupId; checklist_version_id = $activeVersion; force = $false } | ConvertTo-Json -Compress
$job = (Invoke-RestMethod -Method Post -Uri "$api/api/evaluations" -ContentType 'application/json' -Body $body).data
$jobId = $job.id
$jobId | Set-Content -Encoding UTF8 data/runtime/control-job-id.txt
Write-Host "Задание: $jobId"
```

Восстановление наблюдения после закрытия консоли и контроль прогресса:

```powershell
$jobId = (Get-Content data/runtime/control-job-id.txt -Raw).Trim()
do {
    $job = (Invoke-RestMethod "$api/api/jobs/$jobId").data
    $job | Select-Object id, status, processed, total, succeeded, failed, manual_review_count
    if ($job.status -in @('completed', 'failed')) { break }
    Start-Sleep -Seconds 2
} while ($true)
$job | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 data/runtime/control-job.json
```

Тайм-аут команды наблюдения не отменяет серверное задание. Сначала прочитайте его состояние, не создавайте дублирующий запуск. `manual_review_count` — количество разговоров, отмеченных моделью/валидатором, не число всех возможных смысловых ошибок. Для простого запуска есть `backend/scripts/run_batch.py --group CONTROL`: по умолчанию ожидание 2400 с, ID задания печатается в stderr до первого опроса, итоговый JSON — в stdout. Для продолжения ожидания уже созданного задания используйте команду ниже: она выполняет только GET, не создаёт новую оценку. При возобновлении `duration_ms` означает время этой команды, а не полное время серверного задания.

```powershell
& $pythonPath -B backend/scripts/run_batch.py --job-id $jobId --timeout 2400
```

Это же продолжение подходит для job ID из `rehearse_control.py` (его ожидание по умолчанию также 2400 с). Повторный запуск самой репетиции импортирует новую группу, поэтому не используйте его для продолжения ожидания прежней.

### Повтор только упавших разговоров

Дождитесь финального `completed` или `failed`, затем повторите только элементы со статусом `failed`, с исходной версией чек-листа. Успешные разговоры повторно не отправляются:

```powershell
$job = (Invoke-RestMethod "$api/api/jobs/$jobId").data
if ($job.status -notin @('completed', 'failed')) { throw 'Задание ещё выполняется' }
$failedIds = @($job.items | Where-Object status -eq 'failed' | Select-Object -ExpandProperty revision_id)
if ($failedIds.Count -gt 0) {
    $retryBody = @{ revision_ids = $failedIds; checklist_version_id = $job.checklist_version_id; force = $false } | ConvertTo-Json -Depth 10 -Compress
    $retry = (Invoke-RestMethod -Method Post -Uri "$api/api/evaluations" -ContentType 'application/json' -Body $retryBody).data
    $jobId = $retry.id
    $jobId | Set-Content -Encoding UTF8 data/runtime/control-job-id.txt
    Write-Host "Повтор: $jobId"
} else {
    Write-Host 'Упавших разговоров нет'
}
```

Повторите блок наблюдения. Если данные группы уже переимпортированы и изменились, эти ID обозначают прежние ревизии; для новых ревизий запускайте группу заново без `force`, а не используйте старое задание. Не меняйте чек-лист и промпт посреди подготовки итоговой контрольной оценки без отдельной фиксации решения.

## 3. Запасные пути

```powershell
New-Item -ItemType Directory -Force data/runtime, data/raw | Out-Null
```

### Прямая ссылка/импорт не работает

Если серверная настройка источника отсутствует или устарела, скачайте файл через отдельную утилиту. Она попросит ссылку скрытым вводом и сохранит отдельный файл группы. Если сам сервис организаторов недоступен, этот способ тоже не обходит недоступность: нужен ранее сохранённый файл именно нужной группы или новый файл от организаторов.

```powershell
& $pythonPath -B backend/scripts/fetch_dataset.py --group $groupId
if ($LASTEXITCODE -ne 0) { throw 'Скачивание не удалось; не импортируйте старый файл как новый' }
$datasetFile = (Resolve-Path "data/raw/$groupId.json").Path
curl.exe --fail --silent --show-error -X POST "$api/api/imports/file" -F "group_id=$groupId" -F "file=@$datasetFile;type=application/json" -o data/runtime/file-import.json
if ($LASTEXITCODE -ne 0) { throw 'Импорт файла не удался' }
$importReport = (Get-Content data/runtime/file-import.json -Raw | ConvertFrom-Json).data
$importReport | Select-Object received, created, revised, unchanged, skipped
```

При наличии уже сохранённого файла пропустите скачивание, явно выберите этот файл и проверьте его группу. В Windows PowerShell нужен именно `curl.exe`, не псевдоним `curl`.

### 429 или тайм-ауты модели

Посмотрите ошибки элементов завершённого задания. Сервер уже выполняет ограниченные повторы с задержкой; не создавайте несколько заданий на те же ревизии одновременно. После окончания задания остановите сервер Ctrl+C в его консоли и перезапустите с меньшей конкуренцией:

```powershell
$env:LLM_MAX_CONCURRENCY = '1'
& $pythonPath -B -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --env-file .env
```

Затем во второй консоли выполните блок повтора только упавших ревизий. Если пришлось прервать зависшее задание перезапуском, незавершённые элементы получат `INTERRUPTED_BY_RESTART`; успешные сохранятся. Не увеличивайте слепо лимиты: длинный тайм-аут ожидания CLI не исправляет тайм-аут запроса к модели. Изоляция критериев v9 даёт восемь последовательных вызовов на разговор; полный DEV заметно дольше старого пакетного промпта.

### Нет сети — честный демонстрационный режим

Остановите настоящий сервер и используйте отдельную демонстрационную базу, чтобы настоящие результаты оставались удобной базой защиты. Пример ниже требует локального DEV:

```powershell
$env:LLM_PROVIDER = 'fake'
$env:DATABASE_PATH = Join-Path $PWD 'data/demo.db'
& $pythonPath -B -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --env-file .env
```

Во второй консоли импортируйте локальный DEV блоком файлового импорта (`$groupId='DEV'`) и выполните `& $pythonPath -B backend/scripts/run_batch.py --group DEV`. Откройте интерфейс: должна быть плашка **«Демо»**, а у оценок — demo. Preflight намеренно даст FAIL для fake; не представляйте демонстрационные оценки как результат настоящей модели. Fake детерминирован и показывает разнообразные состояния. Для возврата остановите demo-сервер, удалите только временную переменную процесса `Remove-Item Env:DATABASE_PATH` (файл не удаляется), установите `LLM_PROVIDER=openai` и запустите обычный сервер. При нестандартном настоящем пути базы восстановите его значение вместо удаления переменной.

## 4. Восстановление базы из копии

Остановите сервер, убедитесь, что других процессов с этой базой нет. Восстановление заменяет текущие данные состоянием снимка. Утилита сначала проверяет выбранную копию, затем создаёт отдельный защитный снимок текущей базы; без успешного снимка текущие данные не заменяются. Укажите конкретный проверенный файл копии и тот же `$databasePath`, с которым работал сервер (если `DATABASE_PATH` отличается от стандартного, измените строку ниже):

```powershell
$restoreFrom = 'C:\Users\user\AppData\Local\CQA\backups\cqa-YYYYMMDD-HHMMSS-mmm.db'
$databasePath = (Resolve-Path data/cqa.db).Path
$backupDir = Join-Path $env:LOCALAPPDATA 'CQA/backups'
New-Item -ItemType Directory -Force $backupDir | Out-Null
$safetyBackup = Join-Path $backupDir ('before-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.db')
& $pythonPath -B backend/scripts/database_backup.py restore --backup $restoreFrom --database $databasePath --safety-backup $safetyBackup --server-stopped
if ($LASTEXITCODE -ne 0) { throw 'Восстановление не подтверждено; сервер не запускать' }
Write-Host "Защитная копия прежней базы: $safetyBackup"
```

`--server-stopped` — подтверждение оператора, утилита сама не завершает процессы. Обе копии сохраняются; существующий путь защитной копии отклоняется. После успешного восстановления запустите сервер, выполните preflight с ожиданиями 65 / cqa-v9 и проверьте несколько карточек. Задания, попавшие в снимок незавершёнными, после старта помечаются прерванными: повторяйте только их упавшие элементы. Не удаляйте WAL/SHM вручную у работающего сервера.

## 5. Живая замена критерия и откат активной версии

Сохраните исходный ID из раздела 1. Через API создавайте новую версию с полным определением, `activate=true`, `expected_latest_version_id` из `GET /api/checklists/{id}` и `expected_active_version_id` из health. Заменяйте только согласованный критерий, сохраняя остальные. Переоценивайте один неизменённый разговор без `force`: семь прежних критериев должны иметь `reused_from_evaluation_id`, новый — новый вызов. Проверьте `usage.calls`, а не только время.

Откат активации не удаляет экспериментальные версии/оценки и не меняет историю. Читайте текущую активную версию непосредственно перед запросом; при 409 не повторяйте вслепую:

```powershell
$originalVersion = (Get-Content data/runtime/original-version.txt -Raw).Trim()
$currentVersion = (Invoke-RestMethod "$api/api/health").data.active_checklist_version_id
$restoreActivation = @{ expected_active_version_id = $currentVersion } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$api/api/checklist-versions/$originalVersion/activate" -ContentType 'application/json' -Body $restoreActivation | Out-Null
& $pythonPath -B backend/scripts/preflight.py --expected-dev-count 65 --expected-prompt-version cqa-v9
```

Последняя созданная версия после отката остаётся экспериментальной, поэтому для следующего создания берите `latest_version_id` из чек-листа, а не ID активной версии. Оценка экспериментальной версии остаётся в истории разговора; на защите выбирайте оценку исходной версии явно.
