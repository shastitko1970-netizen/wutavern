# WuTavern

Оконный установщик и лаунчер SillyTavern с подключением WuApi. Интерфейс на Tauri, в цветах и шрифтах WuApi Gateway: тёмный фон, красный акцент, Soyuz Grotesk, Outfit, JetBrains Mono.

Расширения не ставит. Отдельного чата здесь нет. SillyTavern скачивается при установке и в этот репозиторий не входит. Её лицензия — AGPL-3.0. Лаунчер — MIT.

## Что делает окно

Первый запуск, если в каталоге нет `server.js`, открывает установщик:

1. Проверяет Node.js. Если в системе нет версии 20 или новее, скачивает свой в `%LOCALAPPDATA%\Wu\runtime\node`.
2. Скачивает текущий GitHub-релиз SillyTavern в выбранный каталог. По умолчанию это `%LOCALAPPDATA%\Wu\SillyTavern`.
3. Ставит зависимости так же, как `Start.bat`: `npm install --omit=dev --ignore-scripts`.
4. Пишет адрес и ключ WuApi в `default-user`.
5. По желанию поднимает сервер и открывает браузер.

Дальше то же окно — лаунчер: запуск, остановка, открытие таверны, смена адреса, ключа, порта и каталога.

Закрытие лаунчера не гасит уже запущенный сервер.

## Куда пишется WuApi

Проверено по полям SillyTavern 1.19. Если в поставленном дереве этих полей нет, установка останавливается.

- Ключ: `data/default-user/secrets.json`, массив `api_key_custom`. Запись `{ id, value, label: "WuApi", active: true }`.
- Соединение: `data/default-user/settings.json`. `main_api` = `openai`, `oai_settings.chat_completion_source` = `custom`, `oai_settings.custom_url` = адрес. SillyTavern сама дописывает `/chat/completions`. Для WuApi адрес указывай вместе с `/v1`.

`enableUserAccounts: true` лаунчер не обслуживает. Имя модели не выбирает.

Ключ в лог не пишется. Лог: `%LOCALAPPDATA%\Wu\logs\wutavern.log`.

Предпочтения лаунчера, без ключа: `%LOCALAPPDATA%\Wu\wutavern.json`.

## Сборка

Нужны Node.js 20+, Rust (MSVC) и WebView2.

```powershell
npm install
npm run dev
```

Установщик Windows:

```powershell
npm run build
```

Файл появляется в `src-tauri\target\release\bundle\nsis\`. Имя включает версию, сейчас `WuTavern_0.1.1_x64-setup.exe`. Это установщик лаунчера. Саму таверну скачивает уже окно WuTavern.

Версия лаунчера растёт только третьей цифрой: `0.1.1`, `0.1.2`, `0.1.3`. Первые две цифры не меняются, пока об этом не скажут отдельно.

## Граница

Здесь нет установки расширений, nestmgr, облачных домов, профиля, отдельного чат-клиента и установки внутрь другого монорепозитория.
