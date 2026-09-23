#!/usr/bin/env node
// Windows launcher: SillyTavern release + WuApi + pack/wu-arc-mode.
// Field names are checked against the installed release (confirmed on 1.19).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(ROOT, 'pack', 'wu-arc-mode', 'manifest.json');
const SECRET_KEY = 'api_key_custom';
const SECRET_LABEL = 'WuApi';
const QR_ID = 'quick-reply';

const HELP = `WuTavern — SillyTavern + WuApi + Memory Books

  node install.mjs [--st-root PATH] [--wuapi-base-url URL] [--wuapi-key KEY]
                   [--log FILE] [--no-start] [--no-browser]

  WUAPI_BASE_URL   OpenAI-compatible base. SillyTavern appends /chat/completions.
  WUAPI_KEY        key written to secrets.json (not to the log)
  ST_ROOT          SillyTavern directory (default: %LOCALAPPDATA%\\Wu\\SillyTavern)
`;

function localAppData() {
    if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
    throw new Error('LOCALAPPDATA is not set');
}

function defaultStRoot() {
    return path.join(localAppData(), 'Wu', 'SillyTavern');
}

function defaultLogFile() {
    return path.join(localAppData(), 'Wu', 'logs', 'wutavern-install.log');
}

function parseArgs(argv) {
    const opts = {
        stRoot: process.env.ST_ROOT || '',
        baseUrl: process.env.WUAPI_BASE_URL || '',
        key: process.env.WUAPI_KEY || '',
        logFile: '',
        noStart: false,
        noBrowser: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const take = () => {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
            return value;
        };
        if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--no-start') opts.noStart = true;
        else if (arg === '--no-browser') opts.noBrowser = true;
        else if (arg === '--st-root') opts.stRoot = take();
        else if (arg === '--wuapi-base-url') opts.baseUrl = take();
        else if (arg === '--wuapi-key') opts.key = take();
        else if (arg === '--log') opts.logFile = take();
        else throw new Error(`unknown argument ${arg}`);
    }
    if (!opts.stRoot) opts.stRoot = defaultStRoot();
    if (!opts.logFile) opts.logFile = defaultLogFile();
    opts.stRoot = path.resolve(opts.stRoot);
    opts.logFile = path.resolve(opts.logFile);
    return opts;
}

function redact(value, secret) {
    const text = String(value ?? '');
    if (!secret || secret.length < 4) return text;
    return text.split(secret).join('[redacted]');
}

function quote(value) {
    const text = String(value).replace(/[\r\n]/g, ' ');
    if (/[\s"]/.test(text)) return `"${text.replace(/"/g, '')}"`;
    return text;
}

function oneLine(error, secret) {
    const text = error instanceof Error ? error.message : String(error);
    return redact(text, secret).replace(/\s+/g, ' ').slice(0, 500);
}

function createLog(file, secret) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return {
        file,
        line(stage, status, fields = {}) {
            const body = Object.entries(fields)
                .map(([key, value]) => `${key}=${quote(redact(value, secret))}`)
                .join(' ');
            const row = `${new Date().toISOString()} ${stage} ${status}${body ? ` ${body}` : ''}`;
            fs.appendFileSync(file, `${row}\n`);
            console.log(row);
        },
    };
}

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env || process.env,
            shell: Boolean(options.shell),
            windowsHide: true,
            stdio: options.stdio || 'inherit',
        });
        let stdout = '';
        let stderr = '';
        if (options.stdio === 'pipe') {
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', chunk => { stdout += chunk; });
            child.stderr?.on('data', chunk => { stderr += chunk; });
        }
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            else reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`));
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function ps(command) {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe' });
    return stdout;
}

function yamlScalar(text, key) {
    const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    if (!match) return undefined;
    let value = match[1].trim().replace(/\s+#.*$/, '').trim();
    if (!value) return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    return value;
}

function configText(stRoot) {
    const configPath = path.join(stRoot, 'config.yaml');
    if (fs.existsSync(configPath)) return { text: fs.readFileSync(configPath, 'utf8'), path: configPath };
    const fallback = path.join(stRoot, 'default', 'config.yaml');
    return { text: fs.readFileSync(fallback, 'utf8'), path: fallback };
}

function dataRootOf(stRoot) {
    const { text } = configText(stRoot);
    const raw = yamlScalar(text, 'dataRoot') || './data';
    return path.isAbsolute(raw) ? raw : path.resolve(stRoot, raw);
}

function portOf(stRoot) {
    const { text } = configText(stRoot);
    const port = Number(yamlScalar(text, 'port') || '8000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('SillyTavern port is not a number');
    }
    return port;
}

function assertAccountsOff(stRoot) {
    const configPath = path.join(stRoot, 'config.yaml');
    if (!fs.existsSync(configPath)) return;
    const text = fs.readFileSync(configPath, 'utf8');
    if (yamlScalar(text, 'enableUserAccounts') === 'true') {
        throw new Error('enableUserAccounts is true; this launcher only writes data/default-user');
    }
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 4)}\n`);
    try {
        fs.rmSync(file, { force: true });
        fs.renameSync(tmp, file);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
}

function normalizeBaseUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) throw new Error('WUAPI_BASE_URL is empty');
    if (!/^https?:\/\//i.test(trimmed)) throw new Error('WUAPI_BASE_URL must start with http:// or https://');
    let url = trimmed.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('WUAPI_BASE_URL must not include userinfo');
    return url;
}

function loadManifest() {
    const manifest = readJson(MANIFEST_PATH);
    if (manifest.id !== 'wu-arc-mode' || String(manifest.version) !== '1') {
        throw new Error('pack manifest must be wu-arc-mode version 1');
    }
    if (!Array.isArray(manifest.extensions) || !Array.isArray(manifest.enable)) {
        throw new Error('pack manifest is missing extensions or enable');
    }
    for (const extension of manifest.extensions) {
        if (extension.install !== 'third-party') {
            throw new Error(`${extension.name || 'extension'} install must be third-party`);
        }
        if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(extension.url || '')) {
            throw new Error(`${extension.name || 'extension'} url must be a public GitHub repo`);
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(extension.name || '')) {
            throw new Error('extension name is not a safe directory name');
        }
    }
    return manifest;
}

function mustInclude(file, needles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) {
        if (!text.includes(needle)) {
            throw new Error(`${path.basename(file)} has no ${needle}`);
        }
    }
}

function assertReleaseContract(stRoot) {
    mustInclude(path.join(stRoot, 'src', 'endpoints', 'secrets.js'), ["CUSTOM: 'api_key_custom'"]);
    mustInclude(path.join(stRoot, 'src', 'endpoints', 'backends', 'chat-completions.js'), [
        'request.body.custom_url',
        '/chat/completions',
    ]);
    mustInclude(path.join(stRoot, 'public', 'script.js'), [
        'oai_settings: oai_settings',
        'world_info_settings:',
        'extension_settings: extension_settings',
    ]);
    mustInclude(path.join(stRoot, 'src', 'server-startup.js'), ['/api/extensions']);
    mustInclude(path.join(stRoot, 'src', 'constants.js'), ['public/scripts/extensions/third-party']);
    mustInclude(path.join(stRoot, 'public', 'scripts', 'extensions', 'quick-reply', 'index.js'), [
        'quickReplyV2',
        'isEnabled',
    ]);
    if (!fs.existsSync(path.join(stRoot, 'public', 'scripts', 'world-info.js'))) {
        throw new Error('public/scripts/world-info.js is missing');
    }
    const pkg = readJson(path.join(stRoot, 'package.json'));
    if (pkg.name !== 'sillytavern') throw new Error(`${stRoot} is not SillyTavern`);
    return pkg.version || '';
}

function userPaths(stRoot) {
    const dataRoot = dataRootOf(stRoot);
    return {
        dataRoot,
        userRoot: path.join(dataRoot, 'default-user'),
        port: portOf(stRoot),
    };
}

async function downloadRelease(zipPath) {
    const metaResponse = await fetch('https://api.github.com/repos/SillyTavern/SillyTavern/releases/latest', {
        headers: {
            'User-Agent': 'wutavern-launcher',
            Accept: 'application/vnd.github+json',
        },
    });
    if (!metaResponse.ok) throw new Error(`GitHub releases/latest returned ${metaResponse.status}`);
    const meta = await metaResponse.json();
    if (!meta.zipball_url || !meta.tag_name) throw new Error('GitHub release has no zipball');
    console.log(`download SillyTavern ${meta.tag_name}`);
    const zipResponse = await fetch(meta.zipball_url, {
        headers: { 'User-Agent': 'wutavern-launcher' },
        redirect: 'follow',
    });
    if (!zipResponse.ok) throw new Error(`release download returned ${zipResponse.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
    return meta.tag_name;
}

function extractedRoot(dir) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
    const children = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (children.length === 1) {
        const nested = path.join(dir, children[0].name);
        if (fs.existsSync(path.join(nested, 'server.js'))) return nested;
    }
    throw new Error('release archive has no server.js');
}

async function installSt(opts) {
    const stRoot = opts.stRoot;
    const serverJs = path.join(stRoot, 'server.js');
    let source = 'found';
    let tag = '';
    if (!fs.existsSync(serverJs)) {
        if (fs.existsSync(stRoot) && fs.readdirSync(stRoot).length > 0) {
            throw new Error(`${stRoot} is not empty and has no server.js`);
        }
        source = 'release';
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wutavern-st-'));
        const zipPath = path.join(tmp, 'sillytavern.zip');
        try {
            tag = await downloadRelease(zipPath);
            const unpack = path.join(tmp, 'unpack');
            fs.mkdirSync(unpack);
            await run('tar', ['-xf', zipPath, '-C', unpack]);
            const extracted = extractedRoot(unpack);
            fs.mkdirSync(stRoot, { recursive: true });
            for (const name of fs.readdirSync(extracted)) {
                fs.cpSync(path.join(extracted, name), path.join(stRoot, name), { recursive: true, force: true });
            }
        } catch (error) {
            if (!fs.existsSync(serverJs)) fs.rmSync(stRoot, { recursive: true, force: true });
            throw error;
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    if (!fs.existsSync(path.join(stRoot, 'node_modules', 'express'))) {
        console.log(`npm install in ${stRoot}`);
        await run('npm', [
            'install',
            '--no-save',
            '--no-audit',
            '--no-fund',
            '--loglevel=error',
            '--no-progress',
            '--omit=dev',
            '--ignore-scripts',
        ], {
            cwd: stRoot,
            shell: true,
            env: { ...process.env, NODE_ENV: 'production' },
        });
    }
    const version = assertReleaseContract(stRoot);
    const paths = userPaths(stRoot);
    return {
        ...paths,
        stRoot,
        source,
        tag: tag || version,
        log: { stRoot, source, tag: tag || version },
    };
}

function settingsFile(ctx) {
    return path.join(ctx.userRoot, 'settings.json');
}

function secretsFile(ctx) {
    return path.join(ctx.userRoot, 'secrets.json');
}

function loadSettings(ctx) {
    const target = settingsFile(ctx);
    const source = fs.existsSync(target)
        ? target
        : path.join(ctx.stRoot, 'default', 'content', 'settings.json');
    if (!fs.existsSync(source)) throw new Error(`settings template missing: ${source}`);
    const settings = readJson(source);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('settings.json is not an object');
    }
    return settings;
}

function extensionSettings(settings) {
    if (!settings.extension_settings || typeof settings.extension_settings !== 'object' || Array.isArray(settings.extension_settings)) {
        settings.extension_settings = {};
    }
    if (!Array.isArray(settings.extension_settings.disabledExtensions)) {
        settings.extension_settings.disabledExtensions = [];
    }
    return settings.extension_settings;
}

function normalizeSecrets(secrets) {
    const values = Object.values(secrets);
    const hasArray = values.some(value => Array.isArray(value));
    const hasString = values.some(value => typeof value === 'string');
    if (!hasString || hasArray || secrets._migrated) return secrets;
    const migrated = { _migrated: [] };
    for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && value.trim()) {
            migrated[key] = [{ id: crypto.randomUUID(), value, label: key, active: true }];
        }
    }
    return migrated;
}

function upsertSecret(secrets, value) {
    const list = Array.isArray(secrets[SECRET_KEY]) ? secrets[SECRET_KEY] : [];
    const same = list.find(entry => entry && entry.value === value);
    for (const entry of list) {
        if (entry && entry !== same) entry.active = false;
    }
    if (same) {
        same.active = true;
        if (!same.label) same.label = SECRET_LABEL;
        secrets[SECRET_KEY] = list;
        return same.id;
    }
    const id = crypto.randomUUID();
    list.push({ id, value, label: SECRET_LABEL, active: true });
    secrets[SECRET_KEY] = list;
    return id;
}

async function nodeCommandLines() {
    const output = await ps(
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress -Depth 3",
    );
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopServer(stRoot) {
    const marker = path.resolve(stRoot, 'server.js').toLowerCase();
    let rows = [];
    try {
        rows = await nodeCommandLines();
    } catch {
        rows = [];
    }
    const pids = rows
        .filter(row => String(row.CommandLine || '').toLowerCase().includes(marker))
        .map(row => Number(row.ProcessId))
        .filter(pid => Number.isInteger(pid) && pid > 0);
    if (pids.length === 0) return false;
    for (const pid of pids) {
        try { process.kill(pid); } catch { /* already gone */ }
    }
    for (let i = 0; i < 50; i++) {
        if (pids.every(pid => !alive(pid))) return true;
        await sleep(200);
    }
    throw new Error(`could not stop SillyTavern (${pids.join(',')})`);
}

async function writeWuApi(ctx, opts) {
    await stopServer(ctx.stRoot);
    assertAccountsOff(ctx.stRoot);
    const settings = loadSettings(ctx);
    settings.main_api = 'openai';
    if (!settings.oai_settings || typeof settings.oai_settings !== 'object' || Array.isArray(settings.oai_settings)) {
        settings.oai_settings = {};
    }
    settings.oai_settings.chat_completion_source = 'custom';
    settings.oai_settings.custom_url = opts.baseUrl;
    const settingsPath = settingsFile(ctx);
    writeJson(settingsPath, settings);
    const writtenSettings = fs.readFileSync(settingsPath, 'utf8');
    if (opts.key.length >= 8 && writtenSettings.includes(opts.key)) {
        throw new Error('refusing to leave the API key in settings.json');
    }

    const secretsPath = secretsFile(ctx);
    const existing = fs.existsSync(secretsPath) ? readJson(secretsPath) : {};
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error('secrets.json is not an object');
    }
    const secrets = normalizeSecrets(existing);
    upsertSecret(secrets, opts.key);
    writeJson(secretsPath, secrets);
    const active = secrets[SECRET_KEY].find(entry => entry.active);
    if (!active || active.value !== opts.key) throw new Error('api_key_custom was not activated');
    return {
        log: {
            secrets: secretsPath,
            settings: settingsPath,
            baseUrl: opts.baseUrl,
        },
    };
}

function dropDisabled(settings, names) {
    const ext = extensionSettings(settings);
    ext.disabledExtensions = ext.disabledExtensions.filter(name => !names.includes(name));
}

function enableWi(settings, stRoot) {
    if (!fs.existsSync(path.join(stRoot, 'public', 'scripts', 'world-info.js'))) {
        throw new Error('World Info module is missing');
    }
    if (!settings.world_info_settings || typeof settings.world_info_settings !== 'object' || Array.isArray(settings.world_info_settings)) {
        const defaults = readJson(path.join(stRoot, 'default', 'content', 'settings.json'));
        if (!defaults.world_info_settings) throw new Error('world_info_settings is missing from this release');
        settings.world_info_settings = defaults.world_info_settings;
    }
    dropDisabled(settings, ['world-info', 'WI']);
}

function enableQr(settings, stRoot) {
    const index = path.join(stRoot, 'public', 'scripts', 'extensions', 'quick-reply', 'index.js');
    if (!fs.existsSync(index)) throw new Error('quick-reply extension is missing');
    dropDisabled(settings, [QR_ID]);
    const ext = extensionSettings(settings);
    const current = ext.quickReplyV2 && typeof ext.quickReplyV2 === 'object' ? ext.quickReplyV2 : {};
    current.isEnabled = true;
    if (!current.config || typeof current.config !== 'object') {
        current.config = { setList: [{ set: 'Default', isVisible: true }] };
    }
    ext.quickReplyV2 = current;
}

const ENABLERS = { WI: enableWi, QR: enableQr };

function thirdPartyDir(stRoot, name) {
    const root = path.resolve(stRoot, 'public', 'scripts', 'extensions', 'third-party');
    const dest = path.resolve(root, name);
    if (dest !== root && !dest.startsWith(`${root}${path.sep}`)) {
        throw new Error('refusing to install outside third-party');
    }
    return dest;
}

async function installExtension(stRoot, extension) {
    const dest = thirdPartyDir(stRoot, extension.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const manifestPath = path.join(dest, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        if (fs.existsSync(dest)) throw new Error(`${dest} exists without manifest.json`);
        await run('git', ['clone', '--depth', '1', extension.url, dest]);
    }
    const manifest = readJson(manifestPath);
    if (!manifest.js || !fs.existsSync(path.join(dest, manifest.js))) {
        throw new Error(`${extension.name} manifest js file is missing`);
    }
    return { dest, displayName: manifest.display_name || extension.name };
}

async function installPack(ctx, opts) {
    await stopServer(ctx.stRoot);
    const manifest = loadManifest();
    const installed = [];
    for (const extension of manifest.extensions) {
        installed.push(await installExtension(ctx.stRoot, extension));
    }
    const settings = loadSettings(ctx);
    for (const extension of manifest.extensions) {
        dropDisabled(settings, [extension.name, `third-party/${extension.name}`]);
    }
    for (const id of manifest.enable) {
        const enable = ENABLERS[id];
        if (!enable) throw new Error(`unknown enable id ${id}`);
        enable(settings, ctx.stRoot);
    }
    writeJson(settingsFile(ctx), settings);
    const check = readJson(settingsFile(ctx));
    if (check.extension_settings?.quickReplyV2?.isEnabled !== true) throw new Error('QR did not stay enabled');
    if (!check.world_info_settings) throw new Error('WI settings are missing');
    if ((check.extension_settings.disabledExtensions || []).includes(QR_ID)) throw new Error('quick-reply is still disabled');
    return {
        log: {
            extension: installed.map(item => item.dest).join(','),
            wi: 'on',
            qr: 'on',
        },
    };
}

async function portAcceptsHttp(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        return true;
    } catch (error) {
        const code = error?.cause?.code || error?.code || '';
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return false;
        if (String(error?.message || '').includes('ECONNREFUSED')) return false;
        if (error?.name === 'TimeoutError' || code === 'ABORT_ERR') return true;
        return false;
    }
}

async function waitReady(port, pid, serverLog) {
    const deadline = Date.now() + 120000;
    let last = 'no response';
    while (Date.now() < deadline) {
        if (!alive(pid)) {
            throw new Error(`server exited before listen: ${tail(serverLog)} ${tail(serverLog.replace(/\.err\.log$/, '.out.log'))}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(3000) });
            if (response.status < 500) return;
            last = `status ${response.status}`;
        } catch (error) {
            last = error?.cause?.code || error.message;
        }
        await sleep(500);
    }
    throw new Error(`SillyTavern did not listen on ${port}: ${last}; ${tail(serverLog)} ${tail(serverLog.replace(/\.err\.log$/, '.out.log'))}`);
}

function tail(file) {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').slice(-400).replace(/\s+/g, ' ').trim();
}

async function discoverExtensions(port) {
    const base = `http://127.0.0.1:${port}`;
    const tokenResponse = await fetch(`${base}/csrf-token`, { signal: AbortSignal.timeout(10000) });
    if (!tokenResponse.ok) throw new Error(`csrf-token returned ${tokenResponse.status}`);
    const cookies = typeof tokenResponse.headers.getSetCookie === 'function'
        ? tokenResponse.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
        : '';
    const body = await tokenResponse.json();
    const response = await fetch(`${base}/api/extensions/discover`, {
        headers: {
            'x-csrf-token': body.token,
            cookie: cookies,
            accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`discover returned ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('discover did not return a list');
    return list;
}

function assertConfigured(ctx, opts) {
    const settings = readJson(settingsFile(ctx));
    if (settings.main_api !== 'openai') throw new Error('main_api is not openai');
    if (settings.oai_settings?.chat_completion_source !== 'custom') throw new Error('chat source is not custom');
    if (settings.oai_settings?.custom_url !== opts.baseUrl) throw new Error('custom_url changed after start');
    if (settings.extension_settings?.quickReplyV2?.isEnabled !== true) throw new Error('QR is off after start');
    if (!settings.world_info_settings) throw new Error('WI settings missing after start');
    const secrets = readJson(secretsFile(ctx));
    const active = (secrets[SECRET_KEY] || []).find(entry => entry && entry.active);
    if (!active || active.value !== opts.key) throw new Error('active api_key_custom does not match the provided key');
}

async function startSt(ctx, opts) {
    await stopServer(ctx.stRoot);
    const serverLog = path.join(path.dirname(opts.logFile), 'sillytavern.out.log');
    if (opts.noStart) {
        return { log: { action: 'skip', stRoot: ctx.stRoot } };
    }
    if (await portAcceptsHttp(ctx.port)) {
        throw new Error(`port ${ctx.port} is already in use`);
    }
    const errorLog = path.join(path.dirname(opts.logFile), 'sillytavern.err.log');
    fs.mkdirSync(path.dirname(serverLog), { recursive: true });
    const args = [path.join(ctx.stRoot, 'server.js')];
    if (opts.noBrowser) args.push('--browserLaunchEnabled=false');
    const pid = await startDetached(ctx.stRoot, args, serverLog, errorLog);
    const pidFile = path.join(ctx.dataRoot, '.wutavern.pid');
    fs.writeFileSync(pidFile, `${pid}\n`);
    try {
        await waitReady(ctx.port, pid, errorLog);
        const list = await discoverExtensions(ctx.port);
        const names = new Set(list.map(item => item.name));
        if (!names.has('third-party/MemoryBooks')) throw new Error('Memory Books is not in Extensions');
        if (!names.has(QR_ID)) throw new Error('quick-reply is not in Extensions');
        assertConfigured(ctx, opts);
        return {
            log: {
                url: `http://127.0.0.1:${ctx.port}`,
                pid,
                serverLog,
            },
        };
    } catch (error) {
        if (alive(pid)) {
            try { process.kill(pid); } catch { /* recorded in the error log */ }
        }
        fs.rmSync(pidFile, { force: true });
        throw error;
    }
}

function psSingle(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function startDetached(stRoot, args, outLog, errLog) {
    const script = [
        "$env:NODE_ENV = 'production'",
        `$p = Start-Process -FilePath ${psSingle(process.execPath)} -ArgumentList @(${args.map(psSingle).join(',')}) -WorkingDirectory ${psSingle(stRoot)} -RedirectStandardOutput ${psSingle(outLog)} -RedirectStandardError ${psSingle(errLog)} -PassThru -WindowStyle Hidden`,
        '$p.Id',
    ].join('\n');
    const file = path.join(os.tmpdir(), `wutavern-start-${process.pid}.ps1`);
    fs.writeFileSync(file, script, 'utf8');
    try {
        const output = await ps(`& ${psSingle(file)}`);
        const id = Number(output.split(/\r?\n/).filter(Boolean).pop());
        if (!Number.isInteger(id) || id <= 0) throw new Error('Start-Process did not return a pid');
        return id;
    } finally {
        fs.rmSync(file, { force: true });
    }
}

async function stage(log, name, secret, fn) {
    try {
        const result = await fn();
        log.line(name, 'ok', result.log || {});
        return result;
    } catch (error) {
        error.stageLogged = true;
        log.line(name, 'fail', { error: oneLine(error, secret) });
        throw error;
    }
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(oneLine(error, ''));
        process.exitCode = 1;
        return;
    }
    if (opts.help) {
        console.log(HELP);
        return;
    }
    const log = createLog(opts.logFile, opts.key);
    try {
        if (process.platform !== 'win32') throw new Error('this launcher is the Windows path');
        const major = Number(process.versions.node.split('.')[0]);
        if (!Number.isFinite(major) || major < 20) throw new Error(`Node.js >= 20 is required (found ${process.versions.node})`);
        if (!opts.baseUrl || !String(opts.key || '').trim()) {
            throw new Error('set WUAPI_BASE_URL and WUAPI_KEY, or pass --wuapi-base-url and --wuapi-key');
        }
        if (/[\r\n]/.test(opts.key)) throw new Error('WUAPI_KEY must be one line');
        opts.baseUrl = normalizeBaseUrl(opts.baseUrl);
        await run('git', ['--version'], { stdio: 'ignore' });
        await run('npm', ['--version'], { shell: true, stdio: 'ignore' });
        const installed = await stage(log, 'install', opts.key, () => installSt(opts));
        await stage(log, 'wuapi', opts.key, () => writeWuApi(installed, opts));
        await stage(log, 'pack', opts.key, () => installPack(installed, opts));
        await stage(log, 'start', opts.key, () => startSt(installed, opts));
    } catch (error) {
        if (!error.stageLogged) log.line('install', 'fail', { error: oneLine(error, opts.key) });
        process.exitCode = 1;
    }
}

main();
