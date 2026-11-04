// Installer / uninstaller for the LCU × OpenCode adapter (SPEC §3). It copies the relay and its
// whole local import closure into a flat prefix (default ~/.local/share/lcu-opencode/current),
// copies the adapters node_modules tree beside it, and registers the relay plus the lifecycle
// plugin in the user's OpenCode config (`mcp.lcu` + `plugins`) — backing the file up and
// replacing it atomically. `--uninstall` removes exactly those entries again (mcp.lcu only when
// its command points at this prefix) and deletes the prefix when its install manifest proves it
// is ours.
//
// Deployed layout (the repo's two source levels are flattened into the prefix root):
//   <prefix>/relay.mjs ipc.mjs sessions.mjs singleton.mjs          ← adapters/opencode/
//   <prefix>/client.mjs diagnostics.mjs host-guard.mjs             ← adapters/ (parent level)
//   <prefix>/node_modules/                                         ← adapters/node_modules
//   <prefix>/plugin/{package.json,index.ts,lifecycle.ts}
// Because repo relay.mjs imports '../client.mjs', which would resolve OUTSIDE a flat prefix,
// the installer rewrites those escaping specifiers to './client.mjs' in the deployed copy only,
// then statically verifies that every relative import of every deployed file resolves inside
// the prefix before anything is written. A future import added to the relay closure that this
// layout cannot flatten fails the install loudly instead of shipping a broken relay.
//
// Discipline: the only LCU interaction is a read-only `<lcu> --version`; `lcu setup` is never
// run; the config merge is a pure function; every external path (prefix, config, lcu, node
// candidates, OpenCode plist, node_modules) is injectable so tests never touch the real HOME,
// the real ~/.config/opencode/opencode.json or /Applications.
// Exit codes: 0 ok · 1 usage error, refused plan, or incomplete uninstall · 2 environment
// failure (wrong platform, unusable lcu, OpenCode too old, unreadable config).
import { execFileSync } from 'node:child_process';
import {
  accessSync, constants as FS_CONSTANTS, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../client.mjs';
import { diagnosticLogDirectory } from '../diagnostics.mjs';
import { defaultLcuPath, defaultStateDirectory } from './singleton.mjs';

/** Version stamped into the install manifest; kept in step with the relay's SERVER_INFO. */
export const INSTALLER_VERSION = '0.1.0';
export const MANIFEST_NAME = 'install-manifest.json';
export const MANIFEST_TOOL = 'lcu-opencode-install';
export const MANIFEST_SCHEMA = 1;
export const BACKUP_SUFFIX = '.bak-lcu-opencode';
/** The node binary preferred for `mcp.lcu.command` when it exists (the CUA runtime's node). */
export const CHATGPT_NODE_PATH = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
export const OPENCODE_PLIST_PATH = '/Applications/OpenCode.app/Contents/Info.plist';
export const OPENCODE_VERSION_KEY = 'CFBundleShortVersionString';
export const OPENCODE_MIN_VERSION = '2.2';
/** Above this size the node_modules copy still proceeds, but says so loudly. */
export const NODE_MODULES_WARN_BYTES = 80 * 1024 * 1024;
/** The plugin directory is copied verbatim: zero dependencies, nothing to npm-install. */
export const PLUGIN_FILES = ['package.json', 'index.ts', 'lifecycle.ts'];

export const USAGE =
  'usage: node install.mjs [--yes] [--uninstall] [--refresh] [--prefix <dir>] [--config <path>] [--lcu <path>]';

/** An environment problem the user must fix before the installer can act; main maps it to exit 2. */
export class EnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** The user declined (or could not grant) consent; carries the plan lines to print; exit 1. */
export class PlanRefused extends Error {
  constructor(lines) {
    super(lines[lines.length - 1]);
    this.name = 'PlanRefused';
    this.lines = lines;
  }
}

const defaultReadFile = path => readFileSync(path, 'utf8');
const defaultNow = () => new Date().toISOString();

function consoleLog() {
  return {
    info: (...parts) => console.log(...parts),
    warn: (...parts) => console.warn(...parts),
    error: (...parts) => console.error(...parts),
  };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** Run a command read-only and return its stdout as text; attach stdout/stderr when it fails. */
export function defaultRun(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8' });
  } catch (error) {
    const wrapped = new Error(`${file} ${args.join(' ')} failed: ${error?.message ?? error}`);
    wrapped.stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    wrapped.stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    throw wrapped;
  }
}

/** Yes/no prompt on the terminal; only used when stdin is a TTY and --yes was not given. */
export async function defaultConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise(resolveAnswer => rl.question(question, resolveAnswer));
    return /^\s*(?:y|yes)\s*$/i.test(String(answer));
  } finally {
    rl.close();
  }
}

/** Every external path and dependency the installer needs, with the real defaults filled in. */
export function resolveInstallDeps(options = {}, { home = homedir() } = {}) {
  const adaptersDir = options.adaptersDir ?? dirname(fileURLToPath(new URL('.', import.meta.url)));
  return {
    adaptersDir,
    home,
    platform: options.platform ?? process.platform,
    yes: options.yes ?? false,
    isTTY: options.isTTY ?? (() => process.stdin.isTTY === true),
    confirm: options.confirm ?? defaultConfirm,
    log: options.log ?? consoleLog(),
    now: options.now ?? defaultNow,
    run: options.run ?? defaultRun,
    prefix: options.prefix ?? join(home, '.local', 'share', 'lcu-opencode', 'current'),
    configPath: options.configPath ?? join(home, '.config', 'opencode', 'opencode.json'),
    lcuPath: options.lcuPath ?? defaultLcuPath({ home }),
    plistPath: options.plistPath ?? OPENCODE_PLIST_PATH,
    minimumOpencodeVersion: options.minimumOpencodeVersion ?? OPENCODE_MIN_VERSION,
    nodeCandidates: options.nodeCandidates ?? [CHATGPT_NODE_PATH],
    relayEntryPath: options.relayEntryPath ?? join(adaptersDir, 'opencode', 'relay.mjs'),
    pluginSourceDir: options.pluginSourceDir ?? join(adaptersDir, 'opencode', 'plugin'),
    nodeModulesPath: options.nodeModulesPath ?? join(adaptersDir, 'node_modules'),
    readFile: options.readFile ?? defaultReadFile,
    du: options.du ?? directoryBytes,
  };
}

/** `node install.mjs [--yes] [--uninstall] [--refresh] [--prefix <dir>] [--config <path>] [--lcu <path>]`. */
export function parseInstallArgs(argv = []) {
  const options = {};
  const valueFlags = [['--prefix', 'prefix'], ['--config', 'configPath'], ['--lcu', 'lcuPath']];
  const booleanFlags = [['--yes', 'yes'], ['--uninstall', 'uninstall'], ['--refresh', 'refresh']];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const boolean = booleanFlags.find(([flag]) => flag === arg);
    if (boolean) {
      options[boolean[1]] = true;
      continue;
    }
    const value = valueFlags.find(([flag]) => flag === arg || arg.startsWith(`${flag}=`));
    if (value) {
      const [flag, key] = value;
      const text = arg === flag ? argv[index + 1] : arg.slice(flag.length + 1);
      if (typeof text !== 'string' || !text) throw new Error(`install option ${flag} needs a non-empty value`);
      options[key] = text;
      if (arg === flag) index += 1;
      continue;
    }
    throw new Error(`Unknown install argument: ${arg}`);
  }
  return options;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function summarize(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/** Order-insensitive deep equality for JSON values, so an unchanged entry never re-warns. */
function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

export function serializeConfig(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The OpenCode config merge — pure functions, unit-tested without any file I/O.
// ---------------------------------------------------------------------------

/**
 * Merge the adapter's entries into a parsed OpenCode config. Sets `mcp.lcu` to the relay
 * command (overwriting any same-named entry, warning when that changes something), appends
 * `<prefix>/plugin` to `plugins` (creating the array; converting a non-array with a warning)
 * and deep-preserves every other field. Returns `{config, warnings}`; never touches the disk.
 */
export function mergeOpencodeConfig(config, { nodePath, prefix, lcuPath }) {
  if (!isPlainObject(config)) throw new TypeError('mergeOpencodeConfig expects a plain object config');
  const warnings = [];
  const next = { ...config };
  const entry = { type: 'local', command: [nodePath, join(prefix, 'relay.mjs'), '--lcu', lcuPath] };

  const mcpSource = config.mcp;
  if (mcpSource !== undefined && !isPlainObject(mcpSource)) {
    warnings.push(`opencode config mcp was ${jsonKind(mcpSource)}, not an object — replacing it with the lcu entry`);
  }
  const mcp = isPlainObject(mcpSource) ? { ...mcpSource } : {};
  if (mcp.lcu !== undefined && !jsonEqual(mcp.lcu, entry)) {
    warnings.push(`overwriting the existing mcp.lcu entry (${summarize(mcp.lcu)}) with the relay command`);
  }
  mcp.lcu = entry;
  next.mcp = mcp;

  const pluginPath = join(prefix, 'plugin');
  const pluginsSource = config.plugins;
  if (pluginsSource === undefined) {
    next.plugins = [pluginPath];
  } else if (!Array.isArray(pluginsSource)) {
    warnings.push(`opencode config plugins was ${jsonKind(pluginsSource)}, not an array — converting it to an array that keeps the original value`);
    next.plugins = [pluginsSource, pluginPath];
  } else if (!pluginsSource.some(candidate => candidate === pluginPath)) {
    next.plugins = [...pluginsSource, pluginPath];
  }
  return { config: next, warnings };
}

/**
 * The uninstall half of the merge: drop `mcp.lcu` only when its command names this prefix's
 * relay (otherwise keep it with a warning) and remove this prefix's plugin entry from
 * `plugins`. Other entries and fields survive untouched. Pure.
 */
export function uninstallFromOpencodeConfig(config, { prefix }) {
  if (!isPlainObject(config)) throw new TypeError('uninstallFromOpencodeConfig expects a plain object config');
  const warnings = [];
  const next = { ...config };
  const relayPath = join(prefix, 'relay.mjs');
  const pluginPath = join(prefix, 'plugin');
  let removedRelay = false;
  let keptRelay = false;
  let removedPlugin = false;

  if (isPlainObject(config.mcp) && config.mcp.lcu !== undefined) {
    const command = config.mcp.lcu?.command;
    if (Array.isArray(command) && command.includes(relayPath)) {
      const rest = { ...config.mcp };
      delete rest.lcu;
      next.mcp = rest;
      removedRelay = true;
    } else {
      keptRelay = true;
      warnings.push(`mcp.lcu does not point at this install (${summarize(config.mcp.lcu)}) — keeping it`);
    }
  }
  if (Array.isArray(config.plugins) && config.plugins.some(candidate => candidate === pluginPath)) {
    next.plugins = config.plugins.filter(candidate => candidate !== pluginPath);
    removedPlugin = true;
  }
  return { config: next, warnings, removedRelay, keptRelay, removedPlugin };
}

// ---------------------------------------------------------------------------
// Import closure derivation — statically parse the relay's local imports so the copy list can
// never drift from what the code actually imports.
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  /\bimport\s[^;'"]*?from\s*['"]([^'"]+)['"]/g, // static named/default/namespace imports
  /\bimport\s*['"]([^'"]+)['"]/g,               // side-effect-only imports
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,     // dynamic import()
  /\bexport\s[^;'"]*?from\s*['"]([^'"]+)['"]/g, // re-exports
];

/** Every module specifier appearing in import/export-from/dynamic-import statements. */
export function importSpecifiers(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

/** Blank out comments so specifier scanning never sees prose; keeps `://` inside strings. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function resolveLocalModule(specifier, importerPath, { stat = statSync } = {}) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importerPath), specifier);
  const candidates = [base];
  if (!/\.(mjs|cjs|js|ts|mts|cts|jsx|tsx|json)$/.test(base)) {
    candidates.push(`${base}.mjs`, `${base}.ts`, join(base, 'index.mjs'), join(base, 'index.ts'));
  }
  for (const candidate of candidates) {
    try {
      if (stat(candidate).isFile()) return candidate;
    } catch { /* not there — try the next candidate */ }
  }
  throw new Error(`cannot resolve the local import '${specifier}' from ${importerPath}`);
}

export function isInside(directory, target) {
  const rel = relative(resolve(directory), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk the relay's relative imports recursively from `entryPath` and return every local module
 * file it needs, in visit order. Fails loudly when an import cannot be resolved, reaches
 * outside the adapters directory (nothing else may be deployed), or when two modules share a
 * basename (the flat prefix layout cannot hold both).
 */
export function deriveRelayClosure(entryPath, { readFile = defaultReadFile } = {}) {
  const entry = resolve(entryPath);
  const adaptersRoot = dirname(dirname(entry));
  const files = [];
  const seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    seen.add(path);
    let source;
    try {
      source = readFile(path);
    } catch (error) {
      throw new Error(`cannot read ${path} while deriving the relay import closure: ${error.message}`);
    }
    files.push(path);
    for (const specifier of importSpecifiers(stripComments(source))) {
      const local = resolveLocalModule(specifier, path);
      if (local !== undefined) visit(local);
    }
  };
  visit(entry);
  for (const file of files) {
    if (!isInside(adaptersRoot, file)) throw new Error(`the relay import closure leaves ${adaptersRoot}: ${file}`);
  }
  const byBase = new Map();
  for (const file of files) {
    const base = basename(file);
    if (byBase.has(base)) throw new Error(`two closure modules share the file name ${base}: ${byBase.get(base)} and ${file}`);
    byBase.set(base, file);
  }
  return files;
}

const SPECIFIER_LEAD = /(from\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]*)['"]/g;

/**
 * Rewrite the relative import specifiers of a file that is deployed flat into the prefix root:
 * any specifier that would resolve outside the prefix (the repo's `../client.mjs` parent-level
 * imports) becomes a same-directory import, because every closure file lands beside it.
 */
export function flattenImportsForPrefix(source, destPath, prefixRoot) {
  return source.replace(SPECIFIER_LEAD, (whole, lead, specifier) => {
    const target = resolve(dirname(destPath), specifier);
    if (isInside(prefixRoot, target)) return whole;
    return `${lead}'./${basename(target)}'`;
  });
}

/**
 * The drift guard: every relative import of every deployed file must resolve inside the prefix
 * AND to another file in the deploy plan. Bare specifiers (node:, @modelcontextprotocol/sdk)
 * are skipped here — they resolve via the copied <prefix>/node_modules at runtime.
 */
export function verifyFlatLayout(planned, prefixRoot) {
  for (const [dest, content] of planned) {
    const label = relative(prefixRoot, dest);
    for (const specifier of importSpecifiers(stripComments(content))) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(dest), specifier);
      if (!isInside(prefixRoot, target)) {
        throw new Error(`deployed ${label} imports '${specifier}', which escapes the install prefix`);
      }
      if (!planned.has(target)) {
        throw new Error(`deployed ${label} imports '${specifier}', which does not resolve to another deployed file (${relative(prefixRoot, target)})`);
      }
    }
  }
}

/** Build the full deploy plan (dest path → file content) without writing anything. */
export function planPrefixFiles(closureFiles, { prefix, pluginSourceDir, readFile = defaultReadFile }) {
  const prefixRoot = resolve(prefix);
  const planned = new Map();
  for (const source of closureFiles) {
    const dest = join(prefixRoot, basename(source));
    planned.set(dest, flattenImportsForPrefix(readFile(source), dest, prefixRoot));
  }
  for (const name of PLUGIN_FILES) {
    planned.set(join(prefixRoot, 'plugin', name), readFile(join(pluginSourceDir, name)));
  }
  verifyFlatLayout(planned, prefixRoot);
  return planned;
}

// ---------------------------------------------------------------------------
// Environment checks and small fs helpers.
// ---------------------------------------------------------------------------

/** The node binary for `mcp.lcu.command`: the first executable candidate, else process.execPath. */
export function resolveNodePath(candidates = [CHATGPT_NODE_PATH], { access = accessSync, execPath = process.execPath } = {}) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try {
      access(candidate, FS_CONSTANTS.X_OK);
      return candidate;
    } catch { /* not usable — try the next candidate */ }
  }
  return execPath;
}

/** `<lcu> --version` must be executable and print something version-shaped; read-only. */
export function checkLcu(lcuPath, { run = defaultRun, access = accessSync } = {}) {
  try {
    access(lcuPath, FS_CONSTANTS.X_OK);
  } catch {
    throw new EnvironmentError(`lcu is not an executable file at ${lcuPath} — install LCU or pass --lcu <path>`);
  }
  let output;
  try {
    output = run(lcuPath, ['--version']);
  } catch (error) {
    const detail = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join(' ').trim();
    throw new EnvironmentError(`lcu --version failed for ${lcuPath}: ${detail.slice(0, 300)}`);
  }
  const text = String(output ?? '').trim();
  if (!/\d/.test(text)) {
    throw new EnvironmentError(`lcu --version printed no version for ${lcuPath}: ${JSON.stringify(text.slice(0, 120))}`);
  }
  return text.split('\n')[0].trim();
}

/** Numeric per-component semver-ish comparison; null when either side is not numeric. */
export function compareVersions(left, right) {
  const parse = value => String(value).trim().split('.').map(part => (/^\d+$/.test(part) ? Number(part) : null));
  const a = parse(left);
  const b = parse(right);
  if (a.some(part => part === null) || b.some(part => part === null)) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** CFBundleShortVersionString via plutil, or undefined when the app/plist is missing or unreadable. */
export function readOpencodeVersion(plistPath, { run = defaultRun } = {}) {
  try {
    return String(run('plutil', ['-extract', OPENCODE_VERSION_KEY, 'raw', '-o', '-', plistPath])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** OpenCode ≥ 2.2 is required; a missing plist only warns, a real older version blocks. */
export function checkOpencodeVersion({
  plistPath = OPENCODE_PLIST_PATH, run = defaultRun, minimum = OPENCODE_MIN_VERSION, log = silentLog,
} = {}) {
  const found = readOpencodeVersion(plistPath, { run });
  if (found === undefined) {
    log.warn(`OpenCode version unknown (${plistPath} missing or unreadable) — continuing without the >= ${minimum} check`);
    return undefined;
  }
  const order = compareVersions(found, minimum);
  if (order === null) {
    log.warn(`OpenCode reports the version ${JSON.stringify(found)}, which cannot be compared against ${minimum} — continuing`);
    return found;
  }
  if (order < 0) throw new EnvironmentError(`OpenCode ${found} at ${plistPath} is older than the required ${minimum}`);
  return found;
}

/** Read + parse the OpenCode config; a corrupt or non-object file is refused, never overwritten. */
export function readOpencodeConfig(configPath, { readFile = defaultReadFile, stat = statSync } = {}) {
  let raw;
  try {
    raw = readFile(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { existed: false, raw: undefined, config: {}, mode: undefined };
    throw new EnvironmentError(`cannot read the OpenCode config at ${configPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EnvironmentError(`${configPath} is not valid JSON (${error.message}) — fix or move the file first; refusing to overwrite it`);
  }
  if (!isPlainObject(parsed)) {
    throw new EnvironmentError(`${configPath} must contain a JSON object (found ${jsonKind(parsed)}) — refusing to overwrite it`);
  }
  let mode;
  try {
    mode = stat(configPath).mode & 0o777;
  } catch {
    mode = undefined;
  }
  return { existed: true, raw, config: parsed, mode };
}

/** Back up the original (overwriting any previous backup), then write via temp file + rename. */
export function writeOpencodeConfig(configPath, text, {
  existed = false, mode, mkdir = mkdirSync, copyFile = copyFileSync, writeFile = writeFileSync, rename = renameSync,
} = {}) {
  mkdir(dirname(configPath), { recursive: true });
  if (existed) copyFile(configPath, `${configPath}${BACKUP_SUFFIX}`);
  const temporary = join(dirname(configPath), `.${basename(configPath)}.lcu-opencode-${process.pid}.tmp`);
  writeFile(temporary, text, { mode: mode ?? 0o644 });
  rename(temporary, configPath);
}

/** Total bytes of every non-symlink file under `directory` (symlinks are not followed). */
export function directoryBytes(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += statSync(full).size;
      } catch { /* vanished — skip it */ }
    }
  }
  return total;
}

/** du -sh style size for humans. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  for (const [unit, size] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)}${unit}`;
  }
  return `${bytes}B`;
}

export function writeManifest(prefix, manifest, { writeFile = writeFileSync } = {}) {
  writeFile(join(prefix, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

export function readManifest(prefix, { readFile = defaultReadFile } = {}) {
  try {
    return JSON.parse(readFile(join(prefix, MANIFEST_NAME)));
  } catch {
    return undefined;
  }
}

/** True only for a manifest this installer wrote — the uninstall safety gate for rm -rf. */
export function isOwnManifest(manifest) {
  return isPlainObject(manifest)
    && manifest.tool === MANIFEST_TOOL
    && manifest.schema === MANIFEST_SCHEMA
    && Array.isArray(manifest.files);
}

// ---------------------------------------------------------------------------
// Orchestrators.
// ---------------------------------------------------------------------------

async function gatePlan(deps, lines, verb) {
  if (deps.yes) return;
  if (!deps.isTTY()) {
    throw new PlanRefused([`${verb} plan (--yes skips this prompt):`, ...lines, `Refusing to ${verb} without --yes because stdin is not a TTY.`]);
  }
  deps.log.info([`${verb} plan (--yes skips this prompt):`, ...lines].join('\n'));
  if (!(await deps.confirm(`Proceed with the ${verb}? [y/N] `))) {
    throw new PlanRefused([`Aborted: the ${verb} was not confirmed.`]);
  }
}

function deployPrefixFiles(planned, { log }) {
  for (const [dest, content] of planned) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { mode: 0o644 });
  }
  log.info(`copied ${planned.size} files (relay import closure + plugin)`);
}

function deployNodeModules({ nodeModulesPath, prefix, bytes, log }) {
  const destination = join(prefix, 'node_modules');
  log.info(`node_modules: ${formatBytes(bytes)} → ${destination}`);
  if (bytes > NODE_MODULES_WARN_BYTES) {
    log.warn(`node_modules is ${formatBytes(bytes)} (over ${formatBytes(NODE_MODULES_WARN_BYTES)}) — copying the whole tree anyway`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(nodeModulesPath, destination, { recursive: true });
}

/** Install (or refresh, which is the same thing) the adapter into the prefix and the config. */
export async function installAdapter(options = {}) {
  const deps = resolveInstallDeps(options);
  const { log, prefix, configPath, lcuPath } = deps;
  if (deps.platform !== 'darwin') {
    throw new EnvironmentError(`the LCU × OpenCode adapter installs on macOS only (this platform: ${deps.platform})`);
  }
  if (!existsSync(deps.nodeModulesPath)) {
    throw new EnvironmentError(`no node_modules at ${deps.nodeModulesPath} — run npm install in adapters/ first`);
  }
  const closure = deriveRelayClosure(deps.relayEntryPath, { readFile: deps.readFile });
  const planned = planPrefixFiles(closure, { prefix, pluginSourceDir: deps.pluginSourceDir, readFile: deps.readFile });
  const nodeModulesBytes = deps.du(deps.nodeModulesPath);
  const nodePath = resolveNodePath(deps.nodeCandidates);

  await gatePlan(deps, [
    `  copy ${planned.size} files (relay import closure + plugin) to ${prefix}`,
    `  copy node_modules (${formatBytes(nodeModulesBytes)}) to ${join(prefix, 'node_modules')}`,
    `  register mcp.lcu: [${nodePath}, ${join(prefix, 'relay.mjs')}, --lcu, ${lcuPath}]`,
    `  register plugin: ${join(prefix, 'plugin')}`,
    `  rewrite ${configPath} in place (backup: ${configPath}${BACKUP_SUFFIX})`,
  ], 'install');

  const lcuVersion = checkLcu(lcuPath, { run: deps.run });
  const opencodeVersion = checkOpencodeVersion({
    plistPath: deps.plistPath, run: deps.run, minimum: deps.minimumOpencodeVersion, log,
  });
  log.info(`lcu: ${lcuPath} (${lcuVersion})`);
  log.info(opencodeVersion === undefined ? 'opencode: version unknown — continuing' : `opencode: ${opencodeVersion}`);
  log.info(`node for mcp.lcu.command: ${nodePath}`);

  // Read + validate + merge the config before touching the disk, so a corrupt config blocks
  // every mutation; only then deploy the prefix, the manifest, and finally the config.
  const { existed, raw, config, mode } = readOpencodeConfig(configPath);
  const { config: merged, warnings } = mergeOpencodeConfig(config, { nodePath, prefix, lcuPath });
  for (const warning of warnings) log.warn(warning);

  deployPrefixFiles(planned, { log });
  deployNodeModules({ nodeModulesPath: deps.nodeModulesPath, prefix, bytes: nodeModulesBytes, log });
  const manifest = {
    tool: MANIFEST_TOOL,
    schema: MANIFEST_SCHEMA,
    version: INSTALLER_VERSION,
    installedAt: deps.now(),
    files: [...planned.keys()].map(dest => relative(prefix, dest)).sort(),
    nodeModulesBytes,
    versions: { adapter: INSTALLER_VERSION, lcu: lcuVersion, opencode: opencodeVersion },
    configPath,
    lcuPath,
    nodePath,
  };
  writeManifest(prefix, manifest);
  log.info(`wrote ${join(prefix, MANIFEST_NAME)}`);

  const text = serializeConfig(merged);
  if (text === raw) {
    log.info(`${configPath} already lists exactly this install — not rewritten`);
  } else {
    writeOpencodeConfig(configPath, text, { existed, mode });
    log.info(`${configPath}: set mcp.lcu, ${existed ? 'updated' : 'created'} plugins (backup: ${configPath}${BACKUP_SUFFIX})`);
  }

  log.info([
    '',
    'Installed. Next steps:',
    '  1. Restart OpenCode completely (quit and reopen) so mcp.lcu and the plugin reload.',
    '  2. In any OpenCode session, ask the model to call js — the first relay becomes the owner.',
    `  3. Optional: run lcu doctor to check the runtime; adapter logs go to ${diagnosticLogDirectory()}.`,
  ].join('\n'));
  return 0;
}

/** Remove the adapter's config entries and (when provably ours) the prefix directory. */
export async function uninstallAdapter(options = {}) {
  const deps = resolveInstallDeps(options);
  const { log, prefix, configPath } = deps;
  const prefixExists = existsSync(prefix);
  const manifest = prefixExists ? readManifest(prefix) : undefined;
  const configExists = existsSync(configPath);
  const leftoverNote = `left in place: the state directory ${defaultStateDirectory({ home: deps.home })} and the config backup`;

  await gatePlan(deps, [
    configExists
      ? `  remove the adapter entries for ${prefix} from ${configPath} (backup: ${configPath}${BACKUP_SUFFIX})`
      : `  ${configPath} does not exist — nothing to clean there`,
    !prefixExists
      ? `  ${prefix} — nothing installed there`
      : isOwnManifest(manifest)
        ? `  remove ${prefix} (installed ${manifest.installedAt})`
        : `  remove ${prefix} — no install manifest, so this needs --yes`,
  ], 'uninstall');

  if (configExists) {
    const { raw, config, existed, mode } = readOpencodeConfig(configPath);
    const { config: next, warnings, removedRelay, keptRelay, removedPlugin } = uninstallFromOpencodeConfig(config, { prefix });
    for (const warning of warnings) log.warn(warning);
    if (removedRelay || removedPlugin) {
      const text = serializeConfig(next);
      if (text !== raw) writeOpencodeConfig(configPath, text, { existed, mode });
      log.info(`${configPath}: removed ${[removedRelay && 'mcp.lcu', removedPlugin && 'the plugin entry'].filter(Boolean).join(' and ')}`);
    } else {
      log.info(`${configPath}: no adapter entries for ${prefix} — nothing removed`);
    }
  }

  if (!prefixExists) {
    log.info(`${prefix}: nothing to remove`);
    log.info(leftoverNote);
    return 0;
  }
  if (isOwnManifest(manifest)) {
    rmSync(prefix, { recursive: true, force: true });
    log.info(`removed ${prefix}`);
  } else if (deps.yes) {
    rmSync(prefix, { recursive: true, force: true });
    log.warn(`removed ${prefix} even though ${MANIFEST_NAME} was missing (--yes)`);
  } else {
    log.warn(`kept ${prefix}: no ${MANIFEST_NAME} — rerun with --yes to remove it anyway`);
    log.info(leftoverNote);
    return 1;
  }
  log.info(leftoverNote);
  return 0;
}

/** CLI entry: parse, dispatch, and map failures to the documented exit codes. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? consoleLog();
  let options;
  try {
    options = parseInstallArgs(argv);
  } catch (error) {
    log.error(`install.mjs: ${error.message}`);
    log.error(USAGE);
    return 1;
  }
  if (options.uninstall && options.refresh) {
    log.error('install.mjs: --uninstall and --refresh cannot be combined');
    return 1;
  }
  try {
    if (options.uninstall) return await uninstallAdapter({ ...deps, ...options });
    return await installAdapter({ ...deps, ...options });
  } catch (error) {
    if (error instanceof PlanRefused) {
      for (const line of error.lines) log.info(line);
      return 1;
    }
    if (error instanceof EnvironmentError) {
      log.error(`install.mjs: ${error.message}`);
      return 2;
    }
    log.error(`install.mjs: ${error?.stack ?? String(error)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    code => { process.exitCode = code ?? 0; },
    error => {
      console.error(`install.mjs: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}