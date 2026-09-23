import "@fontsource/cinzel/700.css";
import "@fontsource/permanent-marker/400.css";
import markUrl from "./assets/wu-avatar.png";
import "./style.css";
import {
  fetchSnapshot,
  installTavern,
  isTauri,
  onProgress,
  openFolder,
  openUrl,
  pickDirectory,
  saveSettings,
  startTavern,
  stopTavern,
  windowAction,
  type ProgressEvent,
  type Snapshot,
} from "./api";

type Screen = "welcome" | "connect" | "folder" | "progress" | "home" | "settings";
type StageStatus = "wait" | "run" | "ok" | "fail" | "skip";

const STEPS: { id: Screen; n: string; title: string; hint: string }[] = [
  { id: "welcome", n: "01", title: "Вход", hint: "Что ставится" },
  { id: "connect", n: "02", title: "WuApi", hint: "Адрес и ключ" },
  { id: "folder", n: "03", title: "Каталог", hint: "Путь и порт" },
  { id: "progress", n: "04", title: "Установка", hint: "Скачивание и старт" },
];

const STAGES: { id: string; title: string }[] = [
  { id: "node", title: "Node.js" },
  { id: "release", title: "SillyTavern" },
  { id: "deps", title: "Зависимости" },
  { id: "wuapi", title: "Ключ WuApi" },
  { id: "start", title: "Сервер" },
];

const STATUS_WORD: Record<StageStatus, string> = {
  wait: "ЖДЁТ",
  run: "ИДЁТ",
  ok: "ГОТОВО",
  fail: "СБОЙ",
  skip: "ПРОПУСК",
};

const emptySnap = (): Snapshot => ({
  installed: false,
  dependencies: false,
  configured: false,
  running: false,
  portBusy: false,
  version: "",
  port: 8000,
  url: "http://127.0.0.1:8000",
  baseUrl: "https://eco.wuproj.com/v1",
  keyHint: "не задан",
  stRoot: "",
  nodeLabel: "Node скачается при установке",
  openBrowser: true,
  logFile: "",
  appVersion: "0.1.1",
});

const state: {
  screen: Screen;
  snap: Snapshot;
  error: string;
  busy: boolean;
  showKey: boolean;
  percent: number;
  log: string[];
  stages: Record<string, { status: StageStatus; message: string }>;
  draft: {
    baseUrl: string;
    key: string;
    port: string;
    stRoot: string;
    openBrowser: boolean;
    startAfter: boolean;
  };
} = {
  screen: "welcome",
  snap: emptySnap(),
  error: "",
  busy: false,
  showKey: false,
  percent: 0,
  log: [],
  stages: Object.fromEntries(STAGES.map((stage) => [stage.id, { status: "wait" as StageStatus, message: "" }])),
  draft: {
    baseUrl: "https://eco.wuproj.com/v1",
    key: "",
    port: "8000",
    stRoot: "",
    openBrowser: true,
    startAfter: true,
  },
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("нет #app");

app.innerHTML = `
  <div class="app">
    <header class="site-header">
      <div class="lockup" data-tauri-drag-region>
        <img class="lockup-mark" src="${markUrl}" alt="" width="46" height="46" />
        <div class="lockup-text">
          <div class="lockup-name">WUTAVERN<span class="sticker-2">WU</span></div>
          <div class="lockup-tag">ТАВЕРНА · WUAPI</div>
        </div>
      </div>
      <nav class="nav-row" id="nav"></nav>
      <div class="wins" data-tauri-drag-region>
        <span class="ver mono" id="ver">0.1.1</span>
        <button type="button" id="min" aria-label="Свернуть">–</button>
        <button type="button" id="max" aria-label="Развернуть">□</button>
        <button type="button" id="close" aria-label="Закрыть">×</button>
      </div>
    </header>
    <div class="meter" aria-hidden="true"><i id="meter"></i></div>
    <main><div class="home-hub" id="stage"></div></main>
  </div>
`;

document.getElementById("min")?.addEventListener("click", () => void actWindow("min"));
document.getElementById("max")?.addEventListener("click", () => void actWindow("max"));
document.getElementById("close")?.addEventListener("click", () => void actWindow("close"));

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function previewScreen(): Screen | null {
  if (isTauri()) return null;
  const value = new URLSearchParams(location.search).get("screen");
  if (value === "welcome" || value === "connect" || value === "folder" || value === "progress" || value === "home" || value === "settings") {
    return value;
  }
  return null;
}

function applyDraft(snap: Snapshot) {
  state.draft.baseUrl = snap.baseUrl || state.draft.baseUrl;
  state.draft.port = String(snap.port || 8000);
  state.draft.stRoot = snap.stRoot || state.draft.stRoot;
  state.draft.openBrowser = snap.openBrowser;
}

function paint() {
  document.body.dataset.busy = state.busy ? "1" : "0";
  document.body.dataset.screen = state.screen;
  const ver = document.getElementById("ver");
  if (ver) ver.textContent = state.snap.appVersion || "0.1.1";
  const meter = document.getElementById("meter");
  if (meter) meter.style.width = state.screen === "progress" ? `${state.percent}%` : "0";
  const nav = document.getElementById("nav");
  const stage = document.getElementById("stage");
  if (!nav || !stage) return;
  nav.innerHTML = navHtml();
  stage.innerHTML = stageHtml();
  bind();
}

function navHtml(): string {
  const installer = state.screen === "welcome" || state.screen === "connect" || state.screen === "folder" || state.screen === "progress";
  if (!installer) {
    return `
      <button type="button" class="nav-chip ${state.screen === "home" ? "is-active" : ""}" data-go="home">Запуск</button>
      <button type="button" class="nav-chip ${state.screen === "settings" ? "is-active" : ""}" data-go="settings">Настройки</button>`;
  }
  const order: Screen[] = ["welcome", "connect", "folder", "progress"];
  const current = order.indexOf(state.screen);
  return STEPS.map((step, index) => {
    const cls = index === current ? "is-active" : "";
    return `<button type="button" class="nav-chip ${cls}" data-step="${step.id}" ${index > current ? "disabled" : ""}>${step.title}</button>`;
  }).join("");
}

function stageHtml(): string {
  if (state.screen === "welcome") return welcomeHtml();
  if (state.screen === "connect") return connectHtml();
  if (state.screen === "folder") return folderHtml();
  if (state.screen === "progress") return progressHtml();
  if (state.screen === "settings") return settingsHtml();
  return homeHtml();
}

function welcomeHtml(): string {
  return `
    <p class="home-hub__k">Установщик</p>
    <h1>Поставь таверну</h1>
    <p class="home-hub__lead">Окно скачает SillyTavern, поставит зависимости и запишет WuApi. Потом из него же её запускают и меняют ключ, адрес и порт.</p>
    <div class="home-hub__lanes">
      <article class="plate home-hub__lane"><h2>Node.js</h2><p>Если в системе нет 20+, лаунчер скачает свой.</p></article>
      <article class="plate home-hub__lane"><h2>WuApi</h2><p>Ключ ляжет в secrets. В лог он не пишется.</p></article>
      <article class="plate home-hub__lane"><h2>Сервер</h2><p>Старт, стоп и браузер — кнопками здесь.</p></article>
    </div>
    <div class="home-hub__actions"><button class="nav-chip is-active" type="button" data-go="connect">Дальше</button></div>
    ${alertHtml()}`;
}

function connectHtml(): string {
  return `
    <p class="home-hub__k">WuApi</p>
    <h1>Куда ходит таверна</h1>
    <p class="home-hub__lead">SillyTavern сама дописывает /chat/completions. Для WuApi оставь адрес с /v1.</p>
    <div class="form">
      <div>
        <span class="k">Адрес</span>
        <div class="field"><input id="baseUrl" spellcheck="false" autocomplete="off" value="${esc(state.draft.baseUrl)}" placeholder="https://eco.wuproj.com/v1"></div>
      </div>
      <div>
        <span class="k">Ключ</span>
        <div class="field">
          <input id="key" spellcheck="false" autocomplete="off" type="${state.showKey ? "text" : "password"}" value="${esc(state.draft.key)}" placeholder="wu-…">
          <button class="peek" type="button" id="peek">${state.showKey ? "скрыть" : "показать"}</button>
        </div>
        <p class="hint">Пустой ключ на повторной установке оставляет уже записанный.</p>
      </div>
    </div>
    <div class="home-hub__actions">
      <button class="nav-chip" type="button" data-go="welcome">Назад</button>
      <button class="nav-chip is-active" type="button" id="toFolder">Дальше</button>
    </div>
    ${alertHtml()}`;
}

function folderHtml(): string {
  return `
    <p class="home-hub__k">Каталог</p>
    <h1>Куда ставить</h1>
    <p class="home-hub__lead">Повторный запуск не скачивает SillyTavern заново, если в каталоге уже есть server.js.</p>
    <div class="form">
      <div>
        <span class="k">Каталог</span>
        <div class="field field--path">
          <input id="stRoot" spellcheck="false" value="${esc(state.draft.stRoot)}" placeholder="C:\\Users\\…\\AppData\\Local\\Wu\\SillyTavern">
          <button class="nav-chip" type="button" id="browse">Обзор</button>
        </div>
      </div>
      <div>
        <span class="k">Порт</span>
        <div class="field field--short"><input id="port" inputmode="numeric" value="${esc(state.draft.port)}"></div>
      </div>
      <button class="plate toggle" type="button" id="openBrowser">
        <span><b>Открыть браузер</b><small>когда сервер ответит на порту</small></span>
        <span class="switch" data-on="${state.draft.openBrowser}"><i></i></span>
      </button>
      <button class="plate toggle" type="button" id="startAfter">
        <span><b>Запустить после установки</b><small>можно поставить и стартовать позже</small></span>
        <span class="switch" data-on="${state.draft.startAfter}"><i></i></span>
      </button>
    </div>
    <div class="home-hub__actions">
      <button class="nav-chip" type="button" data-go="connect">Назад</button>
      <button class="nav-chip is-active" type="button" id="begin">Ставить</button>
    </div>
    ${alertHtml()}`;
}

function progressHtml(): string {
  const rows = STAGES.map((stage, index) => {
    const item = state.stages[stage.id];
    const status = item?.status ?? "wait";
    return `<li data-stage="${stage.id}" data-status="${status}">
      <span class="ord">${String(index + 1).padStart(2, "0")}</span>
      <span><b>${stage.title}</b><span class="msg">${esc(item?.message || "")}</span></span>
      <span class="st">${STATUS_WORD[status]}</span>
    </li>`;
  }).join("");
  const done = STAGES.every((stage) => {
    const status = state.stages[stage.id]?.status;
    return status === "ok" || status === "skip";
  });
  const failed = STAGES.some((stage) => state.stages[stage.id]?.status === "fail");
  return `
    <p class="home-hub__k">Установка</p>
    <h1>${failed ? "Остановилась" : done ? "Стоит" : "Ставлю таверну"}</h1>
    <p class="home-hub__lead">${failed ? "Можно повторить. Уже скачанное заново не качается." : done ? "Таверна на месте. Дальше ей управляет это окно." : "Не закрывай окно, пока стадии не станут готовы. npm может занять несколько минут."}</p>
    <ul class="plate stages">${rows}</ul>
    <div class="plate log" id="log">${state.log.map((line) => `<div>${esc(line)}</div>`).join("")}</div>
    <div class="home-hub__actions">
      ${failed ? `<button class="nav-chip" type="button" data-go="folder">Назад</button><button class="nav-chip is-active" type="button" id="begin">Повторить</button>` : ""}
      ${done ? `<button class="nav-chip is-active" type="button" id="done">В лаунчер</button>` : ""}
    </div>
    ${alertHtml()}`;
}

function homeHtml(): string {
  const running = state.snap.running;
  const busyPort = !running && state.snap.portBusy;
  const title = running ? "Таверна открыта" : busyPort ? "Порт занят" : state.snap.installed ? "Таверна ждёт" : "Таверны ещё нет";
  const lead = running
    ? "Сервер слушает локальный адрес. Окно лаунчера можно закрыть — таверна останется."
    : busyPort
      ? `На порту ${state.snap.port} уже кто-то слушает. Останови этот процесс или смени порт в настройках.`
      : state.snap.installed
        ? "Нажми запуск. Ключ и адрес уже записаны, если ты проходил установку."
        : "Сначала поставь SillyTavern. Установщик скачает её и подключит WuApi.";
  return `
    <p class="home-hub__k">${running ? "слушает" : busyPort ? "порт занят" : "остановлена"}</p>
    <h1>${title}</h1>
    <p class="home-hub__lead">${lead}</p>
    <div class="home-hub__status">
      <div class="plate home-hub__stat"><span class="home-hub__stat-k">Адрес</span><span class="home-hub__stat-v home-hub__stat-v--mono">${esc(state.snap.url)}</span></div>
      <div class="plate home-hub__stat"><span class="home-hub__stat-k">Порт</span><span class="home-hub__stat-v">${state.snap.port}</span></div>
      <div class="plate home-hub__stat"><span class="home-hub__stat-k">SillyTavern</span><span class="home-hub__stat-v">${esc(state.snap.version || "—")}</span></div>
    </div>
    <p class="home-hub__mapk">${esc(state.snap.nodeLabel)}</p>
    <div class="home-hub__actions">
      ${state.snap.installed ? "" : `<button class="nav-chip is-active" type="button" data-go="welcome">К установке</button>`}
      ${running ? `<button class="nav-chip is-active" type="button" id="open">Открыть</button><button class="nav-chip" type="button" id="stop">Остановить</button>` : ""}
      ${!running && state.snap.installed && !busyPort ? `<button class="nav-chip is-active" type="button" id="start">Запустить</button>` : ""}
      ${busyPort ? `<button class="nav-chip is-active" type="button" id="stop">Остановить процесс</button>` : ""}
      <button class="nav-chip" type="button" id="copy">Копировать адрес</button>
    </div>
    ${state.snap.stRoot ? `<button class="path" type="button" id="openRoot">${esc(state.snap.stRoot)}</button>` : ""}
    ${alertHtml()}`;
}

function settingsHtml(): string {
  return `
    <p class="home-hub__k">Настройки</p>
    <h1>Адрес, ключ, порт</h1>
    <p class="home-hub__lead">Пустое поле ключа оставляет текущий ${esc(state.snap.keyHint)}. Если таверна была запущена, после записи она поднимется снова.</p>
    <div class="form">
      <div>
        <span class="k">Адрес WuApi</span>
        <div class="field"><input id="baseUrl" spellcheck="false" value="${esc(state.draft.baseUrl)}"></div>
      </div>
      <div>
        <span class="k">Новый ключ</span>
        <div class="field">
          <input id="key" type="${state.showKey ? "text" : "password"}" spellcheck="false" value="${esc(state.draft.key)}" placeholder="${esc(state.snap.keyHint)}">
          <button class="peek" type="button" id="peek">${state.showKey ? "скрыть" : "показать"}</button>
        </div>
      </div>
      <div>
        <span class="k">Каталог SillyTavern</span>
        <div class="field field--path">
          <input id="stRoot" spellcheck="false" value="${esc(state.draft.stRoot)}">
          <button class="nav-chip" type="button" id="browse">Обзор</button>
        </div>
        <p class="hint">Смена каталога не переносит файлы. Здесь должен уже лежать server.js.</p>
      </div>
      <div>
        <span class="k">Порт</span>
        <div class="field field--short"><input id="port" inputmode="numeric" value="${esc(state.draft.port)}"></div>
      </div>
      <button class="plate toggle" type="button" id="openBrowser">
        <span><b>Открывать браузер при запуске</b><small>лаунчер сам откроет локальный адрес</small></span>
        <span class="switch" data-on="${state.draft.openBrowser}"><i></i></span>
      </button>
    </div>
    <div class="home-hub__actions">
      <button class="nav-chip is-active" type="button" id="save">Сохранить</button>
      <button class="nav-chip" type="button" data-go="home">К запуску</button>
    </div>
    ${alertHtml()}`;
}

function alertHtml(): string {
  if (!state.error) return "";
  return `<div class="alert" role="alert">${esc(state.error)}</div>`;
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((button) => {
    button.addEventListener("click", () => go(button.dataset.go as Screen));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      go(button.dataset.step as Screen);
    });
  });
  document.getElementById("peek")?.addEventListener("click", () => {
    readFields();
    state.showKey = !state.showKey;
    paint();
  });
  document.getElementById("toFolder")?.addEventListener("click", () => {
    readFields();
    if (!validUrl(state.draft.baseUrl)) {
      state.error = "Адрес должен начинаться с http:// или https://";
      paint();
      return;
    }
    go("folder");
  });
  document.getElementById("browse")?.addEventListener("click", () => void browse());
  document.getElementById("openBrowser")?.addEventListener("click", (event) => {
    state.draft.openBrowser = !state.draft.openBrowser;
    const sw = (event.currentTarget as HTMLElement).querySelector(".switch");
    sw?.setAttribute("data-on", String(state.draft.openBrowser));
  });
  document.getElementById("startAfter")?.addEventListener("click", (event) => {
    state.draft.startAfter = !state.draft.startAfter;
    const sw = (event.currentTarget as HTMLElement).querySelector(".switch");
    sw?.setAttribute("data-on", String(state.draft.startAfter));
  });
  document.getElementById("begin")?.addEventListener("click", () => void beginInstall());
  document.getElementById("done")?.addEventListener("click", () => {
    state.screen = "home";
    state.error = "";
    paint();
  });
  document.getElementById("start")?.addEventListener("click", () => void start());
  document.getElementById("stop")?.addEventListener("click", () => void stop());
  document.getElementById("open")?.addEventListener("click", () => void openTavern());
  document.getElementById("copy")?.addEventListener("click", () => void copyUrl());
  document.getElementById("openRoot")?.addEventListener("click", () => void reveal(state.snap.stRoot));
  document.getElementById("save")?.addEventListener("click", () => void save());
  const log = document.getElementById("log");
  if (log) log.scrollTop = log.scrollHeight;
}

function go(screen: Screen) {
  if (state.busy && screen !== "progress") return;
  readFields();
  state.error = "";
  state.screen = screen;
  paint();
}

function readFields() {
  const base = document.querySelector<HTMLInputElement>("#baseUrl");
  const key = document.querySelector<HTMLInputElement>("#key");
  const port = document.querySelector<HTMLInputElement>("#port");
  const root = document.querySelector<HTMLInputElement>("#stRoot");
  if (base) state.draft.baseUrl = base.value.trim();
  if (key) state.draft.key = key.value;
  if (port) state.draft.port = port.value.trim();
  if (root) state.draft.stRoot = root.value.trim();
}

function validUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function portNumber(): number | null {
  const port = Number(state.draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

async function browse() {
  readFields();
  try {
    const picked = isTauri() ? await pickDirectory() : window.prompt("Каталог", state.draft.stRoot);
    if (picked) {
      state.draft.stRoot = picked;
      paint();
    }
  } catch (error) {
    state.error = messageOf(error);
    paint();
  }
}

function resetStages() {
  state.percent = 4;
  state.log = [];
  for (const stage of STAGES) state.stages[stage.id] = { status: "wait", message: "" };
}

function pushLog(line: string) {
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return;
  state.log.push(clean);
  if (state.log.length > 14) state.log.shift();
}

function applyProgress(event: ProgressEvent) {
  const stage = state.stages[event.stage];
  if (stage) {
    stage.status = event.status;
    stage.message = event.message;
  }
  if (event.percent > 0) state.percent = event.percent;
  pushLog(`${event.stage}  ${event.message}`);
  if (state.screen === "progress") paint();
}

async function beginInstall() {
  readFields();
  const port = portNumber();
  if (!validUrl(state.draft.baseUrl)) {
    state.error = "Адрес должен начинаться с http:// или https://";
    state.screen = "connect";
    paint();
    return;
  }
  if (!port) {
    state.error = "Порт — число от 1 до 65535";
    state.screen = "folder";
    paint();
    return;
  }
  if (!state.draft.stRoot && isTauri()) {
    state.error = "Укажи каталог";
    paint();
    return;
  }
  state.error = "";
  state.busy = true;
  resetStages();
  state.screen = "progress";
  paint();
  try {
    if (!isTauri()) {
      await simulate();
      state.snap.installed = true;
      state.snap.dependencies = true;
      state.snap.configured = true;
      state.snap.running = state.draft.startAfter;
      state.snap.port = port;
      state.snap.url = `http://127.0.0.1:${port}`;
      state.snap.baseUrl = state.draft.baseUrl;
      state.snap.stRoot = state.draft.stRoot || "C:\\Users\\you\\AppData\\Local\\Wu\\SillyTavern";
      state.snap.version = "1.19.0";
      state.snap.nodeLabel = "Node 22 · предпросмотр";
      state.snap.keyHint = "…demo";
      return;
    }
    const unlisten = await onProgress(applyProgress);
    try {
      state.snap = await installTavern({
        baseUrl: state.draft.baseUrl,
        key: state.draft.key,
        port,
        stRoot: state.draft.stRoot,
        openBrowser: state.draft.openBrowser,
        startAfter: state.draft.startAfter,
      });
      applyDraft(state.snap);
      state.draft.key = "";
    } finally {
      unlisten();
    }
  } catch (error) {
    state.error = messageOf(error);
    const active = STAGES.find((stage) => state.stages[stage.id]?.status === "run");
    const target = active?.id ?? STAGES.find((stage) => state.stages[stage.id]?.status === "wait")?.id;
    if (target) state.stages[target] = { status: "fail", message: state.error };
    pushLog(state.error);
  } finally {
    state.busy = false;
    paint();
  }
}

async function simulate() {
  const script: ProgressEvent[] = [
    { stage: "node", status: "run", message: "Проверяю Node.js", percent: 8 },
    { stage: "node", status: "ok", message: "Node 22 · предпросмотр", percent: 24 },
    { stage: "release", status: "run", message: "Скачиваю текущий релиз", percent: 36 },
    { stage: "release", status: "ok", message: "SillyTavern 1.19.0", percent: 54 },
    { stage: "deps", status: "run", message: "зависимости ставятся, прошло 3 с", percent: 70 },
    { stage: "deps", status: "ok", message: "Зависимости на месте", percent: 84 },
    { stage: "wuapi", status: "run", message: "Записываю адрес и ключ", percent: 90 },
    { stage: "wuapi", status: "ok", message: "WuApi подключён", percent: 94 },
    { stage: "start", status: state.draft.startAfter ? "ok" : "skip", message: state.draft.startAfter ? "http://127.0.0.1:8000" : "Запуск выключен", percent: 100 },
  ];
  for (const event of script) {
    await new Promise((resolve) => setTimeout(resolve, 160));
    applyProgress(event);
  }
}

async function refresh() {
  if (!isTauri()) return;
  try {
    state.snap = await fetchSnapshot();
    if (state.screen !== "connect" && state.screen !== "folder" && state.screen !== "settings") {
      applyDraft(state.snap);
    }
  } catch (error) {
    state.error = messageOf(error);
  }
}

async function start() {
  state.busy = true;
  state.error = "";
  paint();
  try {
    if (!isTauri()) {
      if (state.snap.portBusy && !state.snap.running) {
        state.snap.portBusy = false;
      } else {
        state.snap.running = true;
        state.snap.portBusy = true;
      }
      return;
    }
    if (state.snap.portBusy && !state.snap.running) {
      state.snap = await stopTavern();
    } else {
      state.snap = await startTavern();
    }
    applyDraft(state.snap);
  } catch (error) {
    state.error = messageOf(error);
  } finally {
    state.busy = false;
    paint();
  }
}

async function stop() {
  state.busy = true;
  state.error = "";
  paint();
  try {
    if (!isTauri()) {
      state.snap.running = false;
      state.snap.portBusy = false;
      return;
    }
    state.snap = await stopTavern();
    applyDraft(state.snap);
  } catch (error) {
    state.error = messageOf(error);
  } finally {
    state.busy = false;
    paint();
  }
}

async function openTavern() {
  try {
    if (!isTauri()) {
      window.open(state.snap.url, "_blank");
      return;
    }
    await openUrl(state.snap.url);
  } catch (error) {
    state.error = messageOf(error);
    paint();
  }
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(state.snap.url);
    pushLog(`скопировано ${state.snap.url}`);
  } catch {
    state.error = "Буфер обмена недоступен. Адрес можно выделить в строке.";
    paint();
  }
}

async function reveal(path: string) {
  if (!path) return;
  try {
    if (isTauri()) await openFolder(path);
  } catch (error) {
    state.error = messageOf(error);
    paint();
  }
}

async function save() {
  readFields();
  const port = portNumber();
  if (!validUrl(state.draft.baseUrl) || !port) {
    state.error = "Проверь адрес и порт.";
    paint();
    return;
  }
  state.busy = true;
  state.error = "";
  paint();
  try {
    if (!isTauri()) {
      state.snap.baseUrl = state.draft.baseUrl;
      state.snap.port = port;
      state.snap.url = `http://127.0.0.1:${port}`;
      state.snap.stRoot = state.draft.stRoot;
      state.snap.openBrowser = state.draft.openBrowser;
      state.draft.key = "";
      state.screen = "home";
      return;
    }
    state.snap = await saveSettings({
      baseUrl: state.draft.baseUrl,
      key: state.draft.key,
      port,
      stRoot: state.draft.stRoot,
      openBrowser: state.draft.openBrowser,
    });
    state.draft.key = "";
    applyDraft(state.snap);
    state.screen = "home";
  } catch (error) {
    state.error = messageOf(error);
  } finally {
    state.busy = false;
    paint();
  }
}

async function actWindow(action: "min" | "max" | "close") {
  if (!isTauri()) return;
  try {
    await windowAction(action);
  } catch (error) {
    state.error = messageOf(error);
    paint();
  }
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Не получилось";
}

function seedPreview(screen: Screen) {
  state.snap.stRoot = "C:\\Users\\you\\AppData\\Local\\Wu\\SillyTavern";
  state.snap.nodeLabel = "Node 22.14 · системный";
  state.snap.appVersion = "0.1.1";
  state.draft.stRoot = state.snap.stRoot;
  if (screen === "home" || screen === "settings") {
    state.snap.installed = true;
    state.snap.dependencies = true;
    state.snap.configured = true;
    state.snap.running = screen === "home";
    state.snap.portBusy = screen === "home";
    state.snap.version = "1.19.0";
    state.snap.keyHint = "…4f2a";
  }
  if (screen === "progress") {
    state.stages.node = { status: "ok", message: "Node 22.14 · системный" };
    state.stages.release = { status: "ok", message: "SillyTavern 1.19.0" };
    state.stages.deps = { status: "run", message: "зависимости ставятся, прошло 42 с" };
    state.percent = 70;
    state.log = [
      "node  Node 22.14 · системный",
      "release  SillyTavern 1.19.0",
      "deps  зависимости ставятся, прошло 42 с",
    ];
  }
  state.screen = screen;
}

async function boot() {
  const forced = previewScreen();
  if (!isTauri()) {
    seedPreview(forced ?? "welcome");
    paint();
    return;
  }
  paint();
  await refresh();
  state.screen = state.snap.installed ? "home" : "welcome";
  if (forced) state.screen = forced;
  paint();
  window.setInterval(() => {
    if (state.busy || state.screen !== "home") return;
    const before = `${state.snap.running}:${state.snap.portBusy}:${state.snap.port}:${state.snap.version}`;
    void refresh().then(() => {
      const after = `${state.snap.running}:${state.snap.portBusy}:${state.snap.port}:${state.snap.version}`;
      if (state.screen === "home" && before !== after) paint();
    });
  }, 2500);
}

void boot();
