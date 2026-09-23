use std::fs;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::logic::{
    accounts_enabled, active_secret, key_hint, normalize_base_url, normalize_secrets, redact,
    set_yaml_port, upsert_secret, validate_key, validate_port, yaml_scalar, DEFAULT_BASE,
    DEFAULT_PORT,
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn try_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    match BUSY.try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::WouldBlock) => {
            Err("Уже выполняется другая операция".into())
        }
        Err(std::sync::TryLockError::Poisoned(poison)) => Ok(poison.into_inner()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub stage: String,
    pub status: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub installed: bool,
    pub dependencies: bool,
    pub configured: bool,
    pub running: bool,
    pub port_busy: bool,
    pub version: String,
    pub port: u16,
    pub url: String,
    pub base_url: String,
    pub key_hint: String,
    pub st_root: String,
    pub node_label: String,
    pub open_browser: bool,
    pub log_file: String,
    pub app_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub base_url: String,
    pub key: String,
    pub port: u16,
    pub st_root: String,
    pub open_browser: bool,
    pub start_after: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub base_url: String,
    pub key: String,
    pub port: u16,
    pub st_root: String,
    pub open_browser: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    st_root: String,
    base_url: String,
    port: u16,
    open_browser: bool,
}

struct NodeBin {
    exe: PathBuf,
    npm_cli: PathBuf,
    label: String,
}

type Report<'a> = &'a dyn Fn(&str, &str, &str, u8);

pub fn snapshot() -> Result<Snapshot, String> {
    let prefs = load_prefs()?;
    let st_root = PathBuf::from(&prefs.st_root);
    let installed = st_root.join("server.js").is_file() && st_root.join("package.json").is_file();
    let dependencies = st_root.join("node_modules").join("express").is_dir();
    let version = if installed {
        package_version(&st_root).unwrap_or_default()
    } else {
        String::new()
    };
    let port = if installed {
        port_of(&st_root).unwrap_or(prefs.port)
    } else {
        prefs.port
    };
    let base_url = configured_base(&st_root).unwrap_or(prefs.base_url.clone());
    let key = if installed {
        active_key(&st_root).unwrap_or(None)
    } else {
        None
    };
    let configured = key.is_some();
    let running = installed && recorded_running(&st_root);
    Ok(Snapshot {
        installed,
        dependencies,
        configured,
        running,
        port_busy: port_open(port),
        version,
        port,
        url: format!("http://127.0.0.1:{port}"),
        base_url,
        key_hint: key_hint(key.as_deref().unwrap_or("")),
        st_root: st_root.display().to_string(),
        node_label: describe_node(),
        open_browser: prefs.open_browser,
        log_file: log_path()?.display().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

pub fn install(req: InstallRequest, report: Report) -> Result<Snapshot, String> {
    let base_url = match normalize_base_url(&req.base_url) {
        Ok(url) => url,
        Err(error) => return fail(report, "wuapi", &error, &req.key),
    };
    if let Err(error) = validate_port(req.port) {
        return fail(report, "release", &error, &req.key);
    }
    let st_root = match clean_root(&req.st_root) {
        Ok(path) => path,
        Err(error) => return fail(report, "release", &error, &req.key),
    };
    let mut prefs = Prefs {
        st_root: st_root.display().to_string(),
        base_url: base_url.clone(),
        port: req.port,
        open_browser: req.open_browser,
    };
    save_prefs(&prefs)?;

    let client = http_client()?;
    report("node", "run", "Проверяю Node.js", 6);
    let node = match ensure_node(&client, report) {
        Ok(node) => node,
        Err(error) => return fail(report, "node", &error, &req.key),
    };
    report("node", "ok", &node.label, 24);
    log_line(&req.key, "node", "ok", &node.label);

    report("release", "run", "Смотрю каталог SillyTavern", 28);
    let version = match ensure_release(&client, &st_root, report) {
        Ok(version) => version,
        Err(error) => return fail(report, "release", &error, &req.key),
    };
    report("release", "ok", &format!("SillyTavern {version}"), 54);
    log_line(&req.key, "release", "ok", &version);

    report("deps", "run", "Ставлю зависимости. Это несколько минут.", 58);
    if let Err(error) = npm_install(&node, &st_root, report) {
        return fail(report, "deps", &error, &req.key);
    }
    report("deps", "ok", "Зависимости на месте", 84);
    log_line(&req.key, "deps", "ok", "express");

    let key = if req.key.trim().is_empty() {
        match active_key(&st_root) {
            Ok(Some(existing)) => existing,
            Ok(None) => return fail(report, "wuapi", "Нужен ключ WuApi", ""),
            Err(error) => return fail(report, "wuapi", &error, ""),
        }
    } else {
        match validate_key(&req.key) {
            Ok(key) => key,
            Err(error) => return fail(report, "wuapi", &error, &req.key),
        }
    };

    report("wuapi", "run", "Записываю адрес и ключ", 88);
    if let Err(error) = write_port(&st_root, req.port) {
        return fail(report, "wuapi", &error, &key);
    }
    if let Err(error) = write_wuapi(&st_root, &base_url, &key) {
        return fail(report, "wuapi", &error, &key);
    }
    prefs.base_url = base_url.clone();
    save_prefs(&prefs)?;
    report("wuapi", "ok", "WuApi подключён", 94);
    log_line(&key, "wuapi", "ok", &base_url);

    if req.start_after {
        report("start", "run", "Поднимаю сервер", 96);
        if let Err(error) = launch(&st_root, &node, req.port, req.open_browser, report) {
            return fail(report, "start", &error, &key);
        }
        report("start", "ok", &format!("http://127.0.0.1:{}", req.port), 100);
        log_line(&key, "start", "ok", &format!("port {}", req.port));
    } else {
        report("start", "skip", "Запуск выключен", 100);
        log_line(&key, "start", "skip", "no-start");
    }
    snapshot()
}

pub fn start_tavern(report: Report) -> Result<Snapshot, String> {
    let prefs = load_prefs()?;
    let st_root = PathBuf::from(&prefs.st_root);
    if !st_root.join("server.js").is_file() {
        return Err("SillyTavern ещё не установлена".into());
    }
    if server_running(&st_root) {
        return snapshot();
    }
    let key = active_key(&st_root)?.ok_or("Ключ WuApi не записан. Открой настройки.")?;
    let base_url = normalize_base_url(&prefs.base_url)?;
    let node = ensure_node_offline()?;
    report("start", "run", "Поднимаю сервер", 40);
    write_port(&st_root, prefs.port)?;
    write_wuapi(&st_root, &base_url, &key)?;
    launch(&st_root, &node, prefs.port, prefs.open_browser, report)?;
    report("start", "ok", &format!("http://127.0.0.1:{}", prefs.port), 100);
    log_line(&key, "start", "ok", &format!("port {}", prefs.port));
    snapshot()
}

pub fn stop_tavern() -> Result<Snapshot, String> {
    let prefs = load_prefs()?;
    stop_server(&PathBuf::from(&prefs.st_root))?;
    log_line("", "stop", "ok", &prefs.st_root);
    snapshot()
}

pub fn save_settings(req: SaveRequest) -> Result<Snapshot, String> {
    let base_url = normalize_base_url(&req.base_url)?;
    validate_port(req.port)?;
    let st_root = clean_root(&req.st_root)?;
    if !st_root.join("server.js").is_file() {
        return Err("В этом каталоге нет SillyTavern. Сначала поставь её.".into());
    }
    let was_running = server_running(&st_root);
    let key = if req.key.trim().is_empty() {
        active_key(&st_root)?.ok_or("Ключ WuApi не записан")?
    } else {
        validate_key(&req.key)?
    };
    let prefs = Prefs {
        st_root: st_root.display().to_string(),
        base_url: base_url.clone(),
        port: req.port,
        open_browser: req.open_browser,
    };
    save_prefs(&prefs)?;
    write_port(&st_root, req.port)?;
    write_wuapi(&st_root, &base_url, &key)?;
    log_line(&key, "settings", "ok", &base_url);
    if was_running {
        let node = ensure_node_offline()?;
        let report = |_: &str, _: &str, _: &str, _: u8| {};
        launch(&st_root, &node, req.port, false, &report)?;
    }
    snapshot()
}

pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err("Можно открыть только локальную таверну".into());
    }
    open_browser(&url)
}

pub fn open_folder(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_dir() {
        return Err("Каталога нет".into());
    }
    let prefs = load_prefs()?;
    let root = PathBuf::from(&prefs.st_root);
    let wu = local_wu()?;
    if path != root && !path.starts_with(&root) && !path.starts_with(&wu) {
        return Err("Этот каталог лаунчер не открывает".into());
    }
    Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("explorer: {error}"))?;
    Ok(())
}

fn fail(report: Report, stage: &str, message: &str, secret: &str) -> Result<Snapshot, String> {
    let message = redact(message, secret);
    report(stage, "fail", &message, 0);
    log_line(secret, stage, "fail", &message);
    Err(message)
}

fn local_wu() -> Result<PathBuf, String> {
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "Нет переменной LOCALAPPDATA".to_string())?;
    Ok(PathBuf::from(base).join("Wu"))
}

fn default_st_root() -> Result<PathBuf, String> {
    Ok(local_wu()?.join("SillyTavern"))
}

fn prefs_path() -> Result<PathBuf, String> {
    Ok(local_wu()?.join("wutavern.json"))
}

fn log_path() -> Result<PathBuf, String> {
    Ok(local_wu()?.join("logs").join("wutavern.log"))
}

fn server_out_log() -> Result<PathBuf, String> {
    Ok(local_wu()?.join("logs").join("sillytavern.out.log"))
}

fn server_err_log() -> Result<PathBuf, String> {
    Ok(local_wu()?.join("logs").join("sillytavern.err.log"))
}

fn clean_root(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let path = if raw.is_empty() {
        default_st_root()?
    } else {
        PathBuf::from(raw)
    };
    if raw.contains(['\n', '\r']) {
        return Err("Путь содержит перенос строки".into());
    }
    if !path.is_absolute() {
        return Err("Каталог должен быть полным путём".into());
    }
    if path.components().count() < 3 {
        return Err("Укажи каталог внутри диска, не его корень".into());
    }
    let lower = path.to_string_lossy().to_lowercase();
    if lower.contains("\\windows\\") || lower.contains("\\program files") {
        return Err("Выбери обычный каталог, не системный".into());
    }
    Ok(path)
}

fn load_prefs() -> Result<Prefs, String> {
    let defaults = Prefs {
        st_root: default_st_root()?.display().to_string(),
        base_url: DEFAULT_BASE.to_string(),
        port: DEFAULT_PORT,
        open_browser: true,
    };
    let path = prefs_path()?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(defaults);
    };
    Ok(serde_json::from_str(&text).unwrap_or(defaults))
}

fn save_prefs(prefs: &Prefs) -> Result<(), String> {
    let path = prefs_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("не удалось создать {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(prefs).map_err(|error| error.to_string())?;
    atomic_write(&path, format!("{body}\n"))
}

fn log_line(secret: &str, stage: &str, status: &str, message: &str) {
    let Ok(path) = log_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let message = redact(message, secret).replace(['\r', '\n'], " ");
    let message: String = message.chars().take(500).collect();
    let line = format!(
        "{} {stage} {status} {message}\n",
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S")
    );
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("wutavern-launcher")
        .redirect(reqwest::redirect::Policy::limited(12))
        .timeout(Duration::from_secs(900))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP-клиент: {error}"))
}

fn probe_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("wutavern-launcher")
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_millis(700))
        .build()
        .map_err(|error| format!("HTTP-клиент: {error}"))
}

fn download(client: &reqwest::blocking::Client, url: &str, dest: &Path, report: Report, stage: &str, start: u8, end: u8) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let part = dest.with_extension("part");
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("не скачалось {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} для {url}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(&part).map_err(|error| format!("не пишется {}: {error}", part.display()))?;
    let mut buf = [0u8; 64 * 1024];
    let mut got = 0u64;
    let mut last = Instant::now();
    loop {
        let read = response.read(&mut buf).map_err(|error| format!("обрыв загрузки: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read]).map_err(|error| format!("запись загрузки: {error}"))?;
        got += read as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            let percent = if total == 0 {
                start
            } else {
                let span = end.saturating_sub(start) as u64;
                start + ((got.saturating_mul(span)) / total) as u8
            };
            let mb = got as f64 / 1_048_576.0;
            let message = if total == 0 {
                format!("скачано {mb:.1} МБ")
            } else {
                format!("скачано {mb:.1} из {:.1} МБ", total as f64 / 1_048_576.0)
            };
            report(stage, "run", &message, percent);
            last = Instant::now();
        }
    }
    file.flush().ok();
    drop(file);
    let _ = fs::remove_file(dest);
    fs::rename(&part, dest).map_err(|error| format!("не удалось сохранить архив: {error}"))?;
    let mut magic = [0u8; 2];
    let mut check = fs::File::open(dest).map_err(|error| error.to_string())?;
    check.read_exact(&mut magic).map_err(|_| "архив пустой".to_string())?;
    if &magic != b"PK" {
        let _ = fs::remove_file(dest);
        return Err("Скачанный файл не является zip-архивом".into());
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let file = fs::File::open(zip_path).map_err(|error| format!("не открывается архив: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("архив повреждён: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("запись архива: {error}"))?;
        let Some(name) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err("В архиве небезопасный путь".into());
        };
        let out = dest.join(&name);
        if entry.is_dir() || entry.name().ends_with('/') {
            fs::create_dir_all(&out).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut outfile = fs::File::create(&out).map_err(|error| format!("не пишется {}: {error}", out.display()))?;
        std::io::copy(&mut entry, &mut outfile).map_err(|error| format!("распаковка {}: {error}", name.display()))?;
    }
    Ok(())
}

fn find_with(dir: &Path, file: &str) -> Result<PathBuf, String> {
    if dir.join(file).is_file() {
        return Ok(dir.to_path_buf());
    }
    let mut dirs = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            dirs.push(entry.path());
        }
    }
    if dirs.len() == 1 && dirs[0].join(file).is_file() {
        return Ok(dirs.remove(0));
    }
    Err(format!("В архиве нет {file}"))
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(src).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let to = dst.join(entry.file_name());
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if kind.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(entry.path(), &to).map_err(|error| format!("копирование {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

struct CleanDir(PathBuf);
impl Drop for CleanDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ensure_node(client: &reqwest::blocking::Client, report: Report) -> Result<NodeBin, String> {
    if let Some(bin) = usable_node() {
        return Ok(bin);
    }
    report("node", "run", "Скачиваю Node.js 20+", 8);
    let index: Vec<Value> = client
        .get("https://nodejs.org/dist/index.json")
        .send()
        .map_err(|error| format!("не открылся список Node.js: {error}"))?
        .error_for_status()
        .map_err(|error| format!("список Node.js: {error}"))?
        .json()
        .map_err(|error| format!("список Node.js не разобрался: {error}"))?;
    let version = index
        .iter()
        .find(|entry| {
            let lts = entry.get("lts").cloned().unwrap_or(Value::Null);
            let files = entry.get("files").and_then(Value::as_array);
            let lts_ok = !matches!(lts, Value::Bool(false) | Value::Null);
            let win = files.map(|items| items.iter().any(|item| item.as_str() == Some("win-x64"))).unwrap_or(false);
            lts_ok && win
        })
        .and_then(|entry| entry.get("version").and_then(Value::as_str))
        .ok_or("На nodejs.org нет LTS-сборки win-x64")?
        .to_string();
    let url = format!("https://nodejs.org/dist/{version}/node-{version}-win-x64.zip");
    let tmp = std::env::temp_dir().join(format!("wutavern-node-{}", std::process::id()));
    let _clean = CleanDir(tmp.clone());
    fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let zip_path = tmp.join("node.zip");
    download(client, &url, &zip_path, report, "node", 8, 20)?;
    let unpack = tmp.join("unpack");
    extract_zip(&zip_path, &unpack)?;
    let inner = find_with(&unpack, "node.exe")?;
    let dest = local_wu()?.join("runtime").join("node");
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|error| format!("не очищается старый Node: {error}"))?;
    }
    copy_dir(&inner, &dest)?;
    usable_node().ok_or("Node.js скачался, но node.exe не запускается".to_string())
}

fn ensure_node_offline() -> Result<NodeBin, String> {
    usable_node().ok_or("Node.js 20+ не найден. Запусти установку ещё раз.".to_string())
}

fn usable_node() -> Option<NodeBin> {
    if let Some(exe) = system_node() {
        if node_major(&exe).unwrap_or(0) >= 20 {
            if let Some(npm_cli) = npm_cli_for(&exe) {
                let version = node_version(&exe).unwrap_or_else(|| "?".into());
                return Some(NodeBin {
                    exe,
                    npm_cli,
                    label: format!("Node {version} · системный"),
                });
            }
        }
    }
    let exe = match local_wu() {
        Ok(root) => root.join("runtime").join("node").join("node.exe"),
        Err(_) => return None,
    };
    if exe.is_file() && node_major(&exe).unwrap_or(0) >= 20 {
        let npm_cli = npm_cli_for(&exe)?;
        let version = node_version(&exe).unwrap_or_else(|| "?".into());
        return Some(NodeBin {
            exe,
            npm_cli,
            label: format!("Node {version} · свой"),
        });
    }
    None
}

fn describe_node() -> String {
    usable_node()
        .map(|bin| bin.label)
        .unwrap_or_else(|| "Node скачается при установке".into())
}

fn system_node() -> Option<PathBuf> {
    let output = Command::new("where")
        .arg("node")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(PathBuf::from(line))
}

fn npm_cli_for(node: &Path) -> Option<PathBuf> {
    let path = node.parent()?.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    path.is_file().then_some(path)
}

fn node_version(exe: &Path) -> Option<String> {
    let output = Command::new(exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim().trim_start_matches('v').to_string())
}

fn node_major(exe: &Path) -> Option<u32> {
    node_version(exe)?.split('.').next()?.parse().ok()
}

fn ensure_release(client: &reqwest::blocking::Client, st_root: &Path, report: Report) -> Result<String, String> {
    if st_root.join("server.js").is_file() {
        let version = assert_contract(st_root)?;
        report("release", "run", "SillyTavern уже лежит в каталоге", 48);
        return Ok(version);
    }
    if st_root.exists() && dir_not_empty(st_root)? {
        return Err(format!("{} не пустой, и в нём нет server.js", st_root.display()));
    }
    report("release", "run", "Скачиваю текущий релиз SillyTavern", 32);
    let meta = client
        .get("https://api.github.com/repos/SillyTavern/SillyTavern/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "wutavern-launcher")
        .send()
        .map_err(|error| format!("GitHub: {error}"))?;
    let status = meta.status();
    let body = meta.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        let snippet: String = body.chars().take(180).collect();
        return Err(format!("GitHub {status}: {snippet}"));
    }
    let meta: Value = serde_json::from_str(&body).map_err(|error| format!("релиз не разобрался: {error}"))?;
    let tag = meta.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string();
    let zip_url = meta
        .get("zipball_url")
        .and_then(Value::as_str)
        .ok_or("У релиза SillyTavern нет архива")?
        .to_string();
    let tmp = std::env::temp_dir().join(format!("wutavern-st-{}", std::process::id()));
    let _clean = CleanDir(tmp.clone());
    fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let zip_path = tmp.join("sillytavern.zip");
    download(client, &zip_url, &zip_path, report, "release", 34, 50)?;
    let unpack = tmp.join("unpack");
    extract_zip(&zip_path, &unpack)?;
    let inner = find_with(&unpack, "server.js")?;
    copy_dir(&inner, st_root)?;
    if !st_root.join("server.js").is_file() {
        let _ = fs::remove_dir_all(st_root);
        return Err("После распаковки нет server.js".into());
    }
    let version = match assert_contract(st_root) {
        Ok(version) => version,
        Err(error) => {
            let _ = fs::remove_dir_all(st_root);
            return Err(error);
        }
    };
    if tag.is_empty() { Ok(version) } else { Ok(format!("{version} ({tag})")) }
}

fn dir_not_empty(dir: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    Ok(entries.next().is_some())
}

fn assert_contract(st_root: &Path) -> Result<String, String> {
    must_include(&st_root.join("src").join("endpoints").join("secrets.js"), &["CUSTOM: 'api_key_custom'"])?;
    must_include(
        &st_root.join("src").join("endpoints").join("backends").join("chat-completions.js"),
        &["request.body.custom_url", "/chat/completions"],
    )?;
    must_include(&st_root.join("public").join("script.js"), &["oai_settings: oai_settings"])?;
    let package = read_json(&st_root.join("package.json"))?;
    if package.get("name").and_then(Value::as_str) != Some("sillytavern") {
        return Err(format!("{} — это не SillyTavern", st_root.display()));
    }
    Ok(package.get("version").and_then(Value::as_str).unwrap_or("").to_string())
}

fn package_version(st_root: &Path) -> Option<String> {
    let package = read_json(&st_root.join("package.json")).ok()?;
    package.get("version").and_then(Value::as_str).map(|text| text.to_string())
}

fn must_include(path: &Path, needles: &[&str]) -> Result<(), String> {
    let text = fs::read_to_string(path).map_err(|_| format!("нет файла {}", path.display()))?;
    for needle in needles {
        if !text.contains(needle) {
            return Err(format!(
                "{} больше не содержит {needle}. Этот релиз SillyTavern лаунчер не умеет подключать.",
                path.file_name().and_then(|name| name.to_str()).unwrap_or("файл")
            ));
        }
    }
    Ok(())
}

fn npm_install(node: &NodeBin, st_root: &Path, report: Report) -> Result<(), String> {
    if st_root.join("node_modules").join("express").is_dir() {
        report("deps", "run", "Зависимости уже стоят", 80);
        return Ok(());
    }
    let log = local_wu()?.join("logs").join("npm.err.log");
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let err_file = fs::File::create(&log).map_err(|error| error.to_string())?;
    let mut command = Command::new(&node.exe);
    command
        .arg(&node.npm_cli)
        .args([
            "install",
            "--no-save",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            "--no-progress",
            "--omit=dev",
            "--ignore-scripts",
        ])
        .current_dir(st_root)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_file))
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = node.exe.parent() {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{};{path}", dir.display()));
    }
    let mut child = command.spawn().map_err(|error| format!("не запустился npm: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!("npm install завершился с ошибкой. {}", tail(&log)));
            }
            Ok(None) => {
                let seconds = started.elapsed().as_secs();
                report("deps", "run", &format!("зависимости ставятся, прошло {seconds} с"), 70);
                std::thread::sleep(Duration::from_secs(3));
            }
            Err(error) => return Err(format!("npm: {error}")),
        }
    }
}

fn config_text(st_root: &Path) -> Result<String, String> {
    let config = st_root.join("config.yaml");
    if config.is_file() {
        return fs::read_to_string(&config).map_err(|error| format!("config.yaml: {error}"));
    }
    let fallback = st_root.join("default").join("config.yaml");
    fs::read_to_string(&fallback).map_err(|error| format!("default/config.yaml: {error}"))
}

fn data_root(st_root: &Path) -> Result<PathBuf, String> {
    let text = config_text(st_root)?;
    let raw = yaml_scalar(&text, "dataRoot").unwrap_or_else(|| "./data".into());
    let path = PathBuf::from(&raw);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(st_root.join(path))
    }
}

fn port_of(st_root: &Path) -> Result<u16, String> {
    let text = config_text(st_root)?;
    let raw = yaml_scalar(&text, "port").unwrap_or_else(|| DEFAULT_PORT.to_string());
    let port: u16 = raw.parse().map_err(|_| "Порт в config.yaml не число".to_string())?;
    validate_port(port)?;
    Ok(port)
}

fn write_port(st_root: &Path, port: u16) -> Result<(), String> {
    validate_port(port)?;
    let config = st_root.join("config.yaml");
    if !config.is_file() {
        let fallback = st_root.join("default").join("config.yaml");
        fs::copy(&fallback, &config).map_err(|error| format!("не удалось создать config.yaml: {error}"))?;
    }
    let text = fs::read_to_string(&config).map_err(|error| error.to_string())?;
    atomic_write(&config, set_yaml_port(&text, port))
}

fn write_wuapi(st_root: &Path, base_url: &str, key: &str) -> Result<(), String> {
    stop_server(st_root)?;
    let config = st_root.join("config.yaml");
    if config.is_file() {
        let text = fs::read_to_string(&config).map_err(|error| error.to_string())?;
        if accounts_enabled(&text) {
            return Err("В config.yaml включён enableUserAccounts. Лаунчер пишет только default-user.".into());
        }
    }
    let user = data_root(st_root)?.join("default-user");
    fs::create_dir_all(&user).map_err(|error| error.to_string())?;
    let settings_path = user.join("settings.json");
    let settings_src = if settings_path.is_file() {
        settings_path.clone()
    } else {
        st_root.join("default").join("content").join("settings.json")
    };
    if !settings_src.is_file() {
        return Err(format!("нет шаблона настроек: {}", settings_src.display()));
    }
    let mut settings = read_json(&settings_src)?;
    if !settings.is_object() {
        return Err("settings.json — не объект".into());
    }
    settings["main_api"] = json!("openai");
    if !settings.get("oai_settings").map(Value::is_object).unwrap_or(false) {
        settings["oai_settings"] = json!({});
    }
    settings["oai_settings"]["chat_completion_source"] = json!("custom");
    settings["oai_settings"]["custom_url"] = json!(base_url);
    write_json(&settings_path, &settings)?;
    let written = fs::read_to_string(&settings_path).map_err(|error| error.to_string())?;
    if key.len() >= 8 && written.contains(key) {
        return Err("Ключ попал в settings.json, запись остановлена".into());
    }

    let secrets_path = user.join("secrets.json");
    let existing = if secrets_path.is_file() {
        read_json(&secrets_path)?
    } else {
        json!({})
    };
    if !existing.is_object() {
        return Err("secrets.json — не объект".into());
    }
    let mut secrets = normalize_secrets(existing);
    upsert_secret(&mut secrets, key);
    write_json(&secrets_path, &secrets)?;
    let check = read_json(&secrets_path)?;
    if active_secret(&check) != Some(key) {
        return Err("Ключ WuApi не стал активным".into());
    }
    Ok(())
}

fn configured_base(st_root: &Path) -> Option<String> {
    let data = data_root(st_root).ok()?;
    let value = read_json(&data.join("default-user").join("settings.json")).ok()?;
    value
        .get("oai_settings")?
        .get("custom_url")?
        .as_str()
        .map(|text| text.to_string())
}

fn active_key(st_root: &Path) -> Result<Option<String>, String> {
    let data = data_root(st_root)?;
    let path = data.join("default-user").join("secrets.json");
    if !path.is_file() {
        return Ok(None);
    }
    let secrets = read_json(&path)?;
    Ok(active_secret(&secrets).map(|text| text.to_string()))
}

fn launch(st_root: &Path, node: &NodeBin, port: u16, open_when_ready: bool, report: Report) -> Result<(), String> {
    stop_server(st_root)?;
    if port_open(port) {
        return Err(format!("Порт {port} уже занят"));
    }
    let out_log = server_out_log()?;
    let err_log = server_err_log()?;
    if let Some(parent) = out_log.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let pid = spawn_server(&node.exe, st_root, &out_log, &err_log)?;
    let pid_path = data_root(st_root)?.join(".wutavern.pid");
    atomic_write(&pid_path, format!("{pid}\n"))?;
    let client = probe_client()?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut last = "нет ответа".to_string();
    let mut last_emit = Instant::now() - Duration::from_secs(10);
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            let _ = fs::remove_file(&pid_path);
            return Err(format!("Сервер закрылся до старта. {}", tail(&err_log)));
        }
        match client.get(format!("http://127.0.0.1:{port}/version")).send() {
            Ok(response) if response.status().as_u16() < 500 => {
                if open_when_ready {
                    if let Err(error) = open_browser(&format!("http://127.0.0.1:{port}")) {
                        report("start", "run", &format!("Сервер готов, браузер не открылся: {error}"), 99);
                    }
                }
                return Ok(());
            }
            Ok(response) => last = format!("статус {}", response.status()),
            Err(error) => last = error.to_string(),
        }
        if last_emit.elapsed() >= Duration::from_secs(3) {
            report("start", "run", "Жду, пока таверна откроет порт", 97);
            last_emit = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if pid_alive(pid) {
        taskkill(pid);
    }
    let _ = fs::remove_file(&pid_path);
    Err(format!("Таверна не открыла порт {port}: {last}. {}", tail(&err_log)))
}

fn spawn_server(node: &Path, st_root: &Path, out_log: &Path, err_log: &Path) -> Result<u32, String> {
    // Win32_Process.Create starts the helper outside this process's job,
    // so the tavern keeps running after the launcher window closes.
    let script_path = local_wu()?.join("logs").join("start-server.ps1");
    let result_path = local_wu()?.join("logs").join("start-server.result");
    let _ = fs::remove_file(&result_path);
    let server_js = st_root.join("server.js");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         try {{\n\
           $env:NODE_ENV = 'production'\n\
           $p = Start-Process -FilePath {node} -ArgumentList @({server}, '--browserLaunchEnabled=false') -WorkingDirectory {cwd} -RedirectStandardOutput {out} -RedirectStandardError {err} -WindowStyle Hidden -PassThru\n\
           Set-Content -LiteralPath {result} -Value (\"ok \" + $p.Id) -Encoding ascii\n\
         }} catch {{\n\
           Set-Content -LiteralPath {result} -Value (\"fail \" + $_.Exception.Message) -Encoding utf8\n\
           exit 1\n\
         }}\n",
        node = ps_quote(&node.display().to_string()),
        server = ps_quote(&server_js.display().to_string()),
        cwd = ps_quote(&st_root.display().to_string()),
        out = ps_quote(&out_log.display().to_string()),
        err = ps_quote(&err_log.display().to_string()),
        result = ps_quote(&result_path.display().to_string()),
    );
    write_utf8_bom(&script_path, &script)?;
    let command = format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {}",
        quote_cmd(&script_path.display().to_string())
    );
    wmi_create(&command, &st_root.display().to_string())?;
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&result_path) {
            let text = text.trim().trim_start_matches('\u{feff}');
            if let Some(id) = text.strip_prefix("ok ") {
                let pid = id.trim().parse::<u32>().map_err(|_| "pid сервера не число".to_string())?;
                if pid > 0 {
                    return Ok(pid);
                }
            }
            if let Some(message) = text.strip_prefix("fail ") {
                return Err(format!("Не удалось запустить сервер: {message}"));
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Сервер не записал pid. Смотри лог в каталоге Wu\\logs.".into())
}

fn wmi_create(command_line: &str, cwd: &str) -> Result<u32, String> {
    let script = format!(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = {cmd}; CurrentDirectory = {cwd} }}\n\
         if ($r.ReturnValue -ne 0) {{ Write-Error (\"Win32_Process.Create \" + $r.ReturnValue); exit 1 }}\n\
         $r.ProcessId\n",
        cmd = ps_quote(command_line),
        cwd = ps_quote(cwd),
    );
    let file = std::env::temp_dir().join(format!("wutavern-wmi-{}-{}.ps1", std::process::id(), unique_suffix()));
    write_utf8_bom(&file, &script)?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &file.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("powershell: {error}"))?;
    let _ = fs::remove_file(&file);
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Не удалось отвязать процесс таверны: {}", one_line(&err)));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let id = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .last()
        .unwrap_or("")
        .trim()
        .parse::<u32>()
        .map_err(|_| "Win32_Process.Create не вернул pid".to_string())?;
    if id == 0 {
        return Err("Win32_Process.Create вернул пустой pid".into());
    }
    Ok(id)
}

fn stop_server(st_root: &Path) -> Result<(), String> {
    let mut pids = matching_pids(st_root).unwrap_or_default();
    if let Ok(data) = data_root(st_root) {
        let pid_path = data.join(".wutavern.pid");
        if let Some(pid) = read_pid(&pid_path) {
            pids.push(pid);
        }
        let _ = fs::remove_file(&pid_path);
    }
    pids.sort_unstable();
    pids.dedup();
    if pids.is_empty() {
        return Ok(());
    }
    for pid in &pids {
        taskkill(*pid);
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if pids.iter().all(|pid| !pid_alive(*pid)) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "Не получилось остановить таверну ({})",
        pids.iter().map(|pid| pid.to_string()).collect::<Vec<_>>().join(",")
    ))
}

fn recorded_running(st_root: &Path) -> bool {
    let Ok(data) = data_root(st_root) else {
        return false;
    };
    read_pid(&data.join(".wutavern.pid")).map(pid_alive).unwrap_or(false)
}

fn server_running(st_root: &Path) -> bool {
    if recorded_running(st_root) {
        return true;
    }
    matching_pids(st_root).map(|pids| !pids.is_empty()).unwrap_or(false)
}

fn matching_pids(st_root: &Path) -> Result<Vec<u32>, String> {
    let marker = st_root.join("server.js").display().to_string().to_lowercase();
    let rows = process_rows()?;
    let mut pids = Vec::new();
    for row in rows {
        let command = row.command_line.unwrap_or_default().to_lowercase();
        if command.contains(&marker) || command.contains("start-server.ps1") {
            if row.process_id > 0 {
                pids.push(row.process_id);
            }
        }
    }
    Ok(pids)
}

#[derive(Deserialize)]
struct ProcRow {
    #[serde(rename = "ProcessId")]
    process_id: u32,
    #[serde(rename = "CommandLine")]
    command_line: Option<String>,
}

fn process_rows() -> Result<Vec<ProcRow>, String> {
    let script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|powershell|cmd)\\.exe$' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress -Depth 3";
    let file = std::env::temp_dir().join(format!("wutavern-ps-{}-{}.ps1", std::process::id(), unique_suffix()));
    write_utf8_bom(&file, script)?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &file.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("powershell: {error}"))?;
    let _ = fs::remove_file(&file);
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Не удалось прочитать список процессов: {}", one_line(&err)));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(text).map_err(|error| format!("список процессов: {error}"))?;
    let rows = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    rows.into_iter()
        .map(|item| serde_json::from_value(item).map_err(|error| error.to_string()))
        .collect()
}

fn taskkill(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let lower = text.to_lowercase();
    if lower.contains("info:") || lower.contains("информация") || lower.contains("no tasks") {
        return false;
    }
    text.contains(&pid.to_string())
}

fn read_pid(path: &Path) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    let pid = text.trim().parse().ok()?;
    (pid > 0).then_some(pid)
}

fn port_open(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(350)).is_ok()
}

fn open_browser(url: &str) -> Result<(), String> {
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("не открылся браузер: {error}"))?;
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("не читается {}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{} не JSON: {error}", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(path, format!("{body}\n"))
}

fn atomic_write(path: &Path, body: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("не удалось создать {}: {error}", parent.display()))?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    fs::write(&tmp, body).map_err(|error| format!("не пишется {}: {error}", tmp.display()))?;
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("не удалось заменить {}: {error}", path.display())
    })
}

fn tail(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    let trimmed = text.trim();
    let start = trimmed.len().saturating_sub(400);
    one_line(&trimmed[start..])
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_cmd(value: &str) -> String {
    format!("\"{}\"", value.replace('"', ""))
}

fn unique_suffix() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0)
}

fn write_utf8_bom(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(text.as_bytes());
    fs::write(path, bytes).map_err(|error| format!("не пишется {}: {error}", path.display()))
}
