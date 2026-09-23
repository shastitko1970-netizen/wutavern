# WuTavern

Windows-лаунчер полной SillyTavern. Один запуск находит или ставит релиз, подключает WuApi и ставит стартовый пак Memory Books.

Код лаунчера открытый (MIT). Он подключает WuApi. Пак — стартовый набор для таверны.

## Что делает

1. Ищет SillyTavern в `--st-root`, в `ST_ROOT` или в `%LOCALAPPDATA%\Wu\SillyTavern`. Если `server.js` там нет, скачивает текущий GitHub release и ставит зависимости так же, как `Start.bat` (`npm install --omit=dev --ignore-scripts`).
2. Записывает base URL и ключ WuApi в каталог пользователя `default-user`.
3. Читает `pack/wu-arc-mode/manifest.json` и клонирует Memory Books в `public/scripts/extensions/third-party/MemoryBooks`.
4. Включает встроенные World Info (WI) и Quick Replies (QR).
5. Дописывает лог стадий `install`, `wuapi`, `pack`, `start` и запускает `node server.js`.

Нужны Node.js 20+ и Git.

## Как запустить

Из каталога этого репозитория, в PowerShell:

```powershell
$env:WUAPI_BASE_URL = "https://eco.wuproj.com/v1"
$env:WUAPI_KEY = "wu-..."
node install.mjs
```

Флаги: `--wuapi-base-url`, `--wuapi-key`, `--st-root`, `--port`, `--log`, `--no-start`, `--no-browser`. `--port` записывает `port` в `config.yaml` SillyTavern. Без флага остаётся порт из конфига, по умолчанию 8000. `--no-start` не поднимает сервер. Процесс `server.js` этого каталога всё равно останавливается перед записью, иначе открытая страница может затереть файл настроек.

`WUAPI_BASE_URL` — OpenAI-compatible корень. SillyTavern сам дописывает `/chat/completions`. Для WuApi укажите адрес вместе с `/v1`. Если в конце уже есть `/chat/completions`, лаунчер этот хвост убирает.

Повторный запуск не скачивает SillyTavern заново. Тот же ключ не записывается вторым активным секретом.

Лог по умолчанию: `%LOCALAPPDATA%\Wu\logs\wutavern-install.log`. Ключ в лог не пишется. У каждой стадии статус `ok` или `fail` и пути.

Сервер, который поднял лаунчер, записан в `data\.wutavern.pid` внутри каталога SillyTavern. Следующий запуск останавливает этот процесс перед записью конфига и клоном, затем стартует снова: иначе список Extensions не видит новый каталог.

Браузер открывает сам SillyTavern, если в его `config.yaml` включён `browserLaunch`. `--no-browser` передаёт `--browserLaunchEnabled=false`.

## Куда пишется WuApi

Проверено по SillyTavern release 1.19. Лаунчер читает поставленное дерево и останавливается, если этих полей больше нет. Чужие поля не выдумывает.

- Ключ: `data/default-user/secrets.json`, массив `api_key_custom`. Запись `{ id, value, label: "WuApi", active: true }`. Сервер берёт активный элемент (`SECRET_KEYS.CUSTOM` в `src/endpoints/secrets.js`).
- Соединение: `data/default-user/settings.json`. `main_api` = `openai`, `oai_settings.chat_completion_source` = `custom`, `oai_settings.custom_url` = base URL. Генерация ходит на `custom_url + "/chat/completions"` (`src/endpoints/backends/chat-completions.js`).
- QR: встроенное расширение `public/scripts/extensions/quick-reply`. Лаунчер убирает `quick-reply` из `extension_settings.disabledExtensions` и ставит `extension_settings.quickReplyV2.isEnabled` в `true`. В релизe свой тумблер QR по умолчанию выключен, одного отсутствия в `disabledExtensions` мало.
- WI: встроенный модуль `public/scripts/world-info.js`, не git-репозиторий. В релизe нет отдельного выключателя: модуль работает, когда в настройках есть `world_info_settings`. Лаунчер оставляет уже записанный блок или копирует его из `default/content/settings.json` и не кладёт WI в `disabledExtensions`.

`enableUserAccounts: true` лаунчер не обслуживает. Он пишет только `default-user` при выключенных аккаунтах.

Имя модели лаунчер не выбирает. Его задают в SillyTavern после старта.

## Стоп-лист

Здесь нет:

- nestmgr и облачных домов для новых пользователей
- профиля и коллекции
- отдельного чат-клиента
- extract-facts
- установки внутрь другого монорепо

## Лицензия

Лаунчер — [MIT](LICENSE). Он подключает WuApi.

SillyTavern и Memory Books ставятся отдельно, в этот репозиторий не входят, у каждого своя лицензия (в их манифестах указана AGPL-3.0).
