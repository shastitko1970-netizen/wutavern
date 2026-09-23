# WuTavern

Лаунчер и установщик полной SillyTavern. Он подключает WuApi. Расширения не ставит.

Сейчас в репозитории Windows-вход: `node install.mjs`. Релизы того же установщика для macOS и Android (там таверна ставится через Termux, этот процесс и надо автоматизировать) ещё не собраны.

Код лаунчера открытый (MIT).

## Что делает Windows-скрипт

1. Ищет SillyTavern в `--st-root`, в `ST_ROOT` или в `%LOCALAPPDATA%\Wu\SillyTavern`. Если `server.js` там нет, скачивает текущий GitHub release и ставит зависимости так же, как `Start.bat` (`npm install --omit=dev --ignore-scripts`).
2. Записывает base URL и ключ WuApi в каталог пользователя `default-user`.
3. Пишет лог стадий `install`, `wuapi`, `start` и запускает `node server.js`.

Нужен Node.js 20+.

## Как запустить

Из каталога этого репозитория, в PowerShell:

```powershell
$env:WUAPI_BASE_URL = "https://eco.wuproj.com/v1"
$env:WUAPI_KEY = "wu-..."
node install.mjs
```

Флаги: `--wuapi-base-url`, `--wuapi-key`, `--st-root`, `--port`, `--log`, `--no-start`, `--no-browser`. `--port` записывает `port` в `config.yaml` SillyTavern. Без флага остаётся порт из конфига, по умолчанию 8000. `--no-start` не поднимает сервер. Процесс `server.js` этого каталога останавливается перед записью, иначе открытая страница может затереть файл настроек.

`WUAPI_BASE_URL` — OpenAI-compatible корень. SillyTavern сам дописывает `/chat/completions`. Для WuApi укажите адрес вместе с `/v1`. Если в конце уже есть `/chat/completions`, лаунчер этот хвост убирает.

Повторный запуск не скачивает SillyTavern заново. Тот же ключ не записывается вторым активным секретом.

Лог по умолчанию: `%LOCALAPPDATA%\Wu\logs\wutavern-install.log`. Ключ в лог не пишется. У каждой стадии статус `ok` или `fail` и пути.

Сервер, который поднял лаунчер, записан в `data\.wutavern.pid` внутри каталога SillyTavern. Следующий запуск останавливает этот процесс перед записью конфига и стартует снова.

Браузер открывает сам SillyTavern, если в его `config.yaml` включён `browserLaunch`. `--no-browser` передаёт `--browserLaunchEnabled=false`.

## Куда пишется WuApi

Проверено по SillyTavern release 1.19. Лаунчер читает поставленное дерево и останавливается, если этих полей больше нет.

- Ключ: `data/default-user/secrets.json`, массив `api_key_custom`. Запись `{ id, value, label: "WuApi", active: true }`. Сервер берёт активный элемент (`SECRET_KEYS.CUSTOM` в `src/endpoints/secrets.js`).
- Соединение: `data/default-user/settings.json`. `main_api` = `openai`, `oai_settings.chat_completion_source` = `custom`, `oai_settings.custom_url` = base URL. Генерация ходит на `custom_url + "/chat/completions"` (`src/endpoints/backends/chat-completions.js`).

`enableUserAccounts: true` лаунчер не обслуживает. Он пишет только `default-user` при выключенных аккаунтах.

Имя модели лаунчер не выбирает. Его задают в SillyTavern после старта.

## Стоп-лист

Здесь нет:

- установки расширений и стартовых паков
- nestmgr и облачных домов для новых пользователей
- профиля и коллекции
- отдельного чат-клиента
- extract-facts
- установки внутрь другого монорепо

## Лицензия

Лаунчер — [MIT](LICENSE). Он подключает WuApi.

SillyTavern ставится отдельно и в этот репозиторий не входит. Её лицензия — AGPL-3.0.
