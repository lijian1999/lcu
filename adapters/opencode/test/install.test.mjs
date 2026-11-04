// Installer tests (SPEC §3, stage 3): the pure config merge, the static import-closure
// derivation that keeps the deploy list from drifting, the disk layer (backup + atomic
// replace), the prechecks with injected subprocesses, and full install/refresh/uninstall
// flows against temporary directories only. Nothing here touches the real HOME, the real
// ~/.config/opencode/opencode.json, or /Applications — every path and subprocess is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BACKUP_SUFFIX, CHATGPT_NODE_PATH, compareVersions, checkLcu, checkOpencodeVersion,
  deriveRelayClosure, directoryBytes, EnvironmentError, flattenImportsForPrefix, formatBytes,
  importSpecifiers, INSTALLER_VERSION, installAdapter, isInside, isOwnManifest, main,
  MANIFEST_NAME, MANIFEST_SCHEMA, MANIFEST_TOOL, mergeOpencodeConfig, parseInstallArgs,
  planPrefixFiles, PLUGIN_FILES, readManifest, readOpencodeConfig, readOpencodeVersion,
  resolveNodePath, serializeConfig, stripComments, uninstallFromOpencodeConfig,
  USAGE, verifyFlatLayout, writeManifest, writeOpencodeConfig,
} from '../install.mjs';
import { makeTempDirectory, removeTempDirectory } from './helpers.mjs';

const REPO_RELAY = fileURLToPath(new URL('../relay.mjs', import.meta.url));
const REPO_PLUGIN_DIR = fileURLToPath(new URL('../plugin', import.meta.url));
const REPO_ADAPTERS_DIR = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL_SCRIPT = fileURLToPath(new URL('../install.mjs', import.meta.url));

const NODE = '/fake/bin/node';
const LCU = '/fake/bin/lcu';
const PREFIX = '/fake/prefix/current';
const RELAY_ENTRY = { type: 'local', command: [NODE, join(PREFIX, 'relay.mjs'), '--lcu', LCU] };

/** A log stand-in that records levelled lines so tests can assert the installer's chatter. */
function recordLog() {
  const lines = [];
  return {
    lines,
    text(level) { return lines.filter(([lineLevel]) => lineLevel === level).map(([, text]) => text); },
    info: (...parts) => lines.push(['info', parts.join(' ')]),
    warn: (...parts) => lines.push(['warn', parts.join(' ')]),
    error: (...parts) => lines.push(['error', parts.join(' ')]),
  };
}

/** A stand-in for execFileSync: answers the lcu/plutil probes, refuses anything else. */
function fakeRun({ lcuPath, lcuVersion = 'lcu 0.4.0-test', plistVersion = '9.9.9' } = {}) {
  const calls = [];
  return {
    calls,
    run(file, args) {
      calls.push([file, ...args]);
      if (file === lcuPath && args[0] === '--version') return `${lcuVersion}\n`;
      if (file === 'plutil') return `${plistVersion}\n`;
      throw new Error(`unexpected exec in test: ${file} ${args.join(' ')}`);
    },
  };
}

/** A real executable placeholder (the X_OK checks run for real; the injected `run` never execs). */
function makeExecutable(directory, name, content = '#!/bin/sh\nexit 0\n') {
  const path = join(directory, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

/** A minimal stand-in for the adapters node_modules tree (structure is all the copier needs). */
function makeFakeNodeModules(root) {
  const sdk = join(root, 'node_modules', '@modelcontextprotocol', 'sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.30.0' }));
  writeFileSync(join(sdk, 'index.js'), 'export {};\n');
  return join(root, 'node_modules');
}

/** A user-shaped seed config: Chinese keys, nesting, a sibling MCP server, an existing plugin. */
function seedConfigText() {
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    '模型': { '嵌套': [1, 2, { 深: true }] },
    model: 'omlx/example',
    providers: { spark: { settings: { baseURL: 'http://127.0.0.1:8000/v1' } } },
    mcp: {
      lcu: { type: 'local', command: ['/Users/example/.local/share/lcu/current/bin/lcu'] },
      rea: { type: 'local', command: ['/opt/homebrew/bin/rea', 'mcp'] },
    },
    plugins: ['/somewhere/else-plugin'],
  }, null, 2)}\n`;
}

/** Shared dependency set for the flow tests: everything external points into `root`. */
function flowDeps(root, overrides = {}) {
  const prefix = join(root, 'prefix', 'current');
  const configPath = join(root, 'config', 'opencode.json');
  const lcu = makeExecutable(root, 'lcu');
  const node = makeExecutable(root, 'cua-node');
  const nodeModules = makeFakeNodeModules(root);
  const exec = fakeRun({ lcuPath: lcu });
  let tick = 0;
  return {
    prefix, configPath, lcu, node, nodeModules, exec,
    deps: {
      prefix,
      configPath,
      lcuPath: lcu,
      run: exec.run,
      nodeCandidates: [node],
      nodeModulesPath: nodeModules,
      plistPath: join(root, 'missing', 'Info.plist'),
      now: () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++)).toISOString(),
      ...overrides,
    },
  };
}

test('install arguments parse like the relay’s, including --flag=value, and refuse anything else', () => {
  assert.deepEqual(
    parseInstallArgs(['--yes', '--uninstall', '--prefix', '/a/p', '--config=/a/c.json', '--lcu', '/a/lcu']),
    { yes: true, uninstall: true, prefix: '/a/p', configPath: '/a/c.json', lcuPath: '/a/lcu' },
  );
  assert.deepEqual(parseInstallArgs(['--refresh']), { refresh: true });
  assert.deepEqual(parseInstallArgs([]), {});
  assert.throws(() => parseInstallArgs(['--bogus']), /Unknown install argument/);
  assert.throws(() => parseInstallArgs(['--prefix']), /needs a non-empty value/);
  assert.throws(() => parseInstallArgs(['--prefix=']), /needs a non-empty value/);
  assert.match(USAGE, /--uninstall/);
});

test('mergeOpencodeConfig builds mcp.lcu and plugins from an empty config, with no warnings', () => {
  const { config, warnings } = mergeOpencodeConfig({}, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(config, { mcp: { lcu: RELAY_ENTRY }, plugins: [join(PREFIX, 'plugin')] });
  assert.deepEqual(warnings, []);
});

test('mergeOpencodeConfig deep-preserves every other field, including Chinese keys and nested values', () => {
  const original = JSON.parse(seedConfigText());
  const { config, warnings } = mergeOpencodeConfig(original, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  // The seed mirrors the real user config: an mcp.lcu that does not use the relay yet is
  // overwritten (with a warning), while every other field survives untouched.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overwriting the existing mcp.lcu entry/);
  assert.deepEqual(config['模型'], original['模型']);
  assert.deepEqual(config.providers, original.providers);
  assert.strictEqual(config.$schema, original.$schema);
  assert.strictEqual(config.model, original.model);
  // Entries we did not touch keep their identity, not a copy.
  assert.strictEqual(config.mcp.rea, original.mcp.rea);
  assert.strictEqual(config.plugins[0], '/somewhere/else-plugin');
  assert.deepEqual(config.mcp.lcu, RELAY_ENTRY);
  assert.deepEqual(config.plugins, ['/somewhere/else-plugin', join(PREFIX, 'plugin')]);
});

test('mergeOpencodeConfig is idempotent and stays silent on the second run', () => {
  const first = mergeOpencodeConfig({}, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  const second = mergeOpencodeConfig(first.config, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(second.config, first.config);
  assert.deepEqual(second.warnings, []);
  const seeded = mergeOpencodeConfig(JSON.parse(seedConfigText()), { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  const reseeded = mergeOpencodeConfig(seeded.config, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(reseeded.config, seeded.config);
  assert.deepEqual(reseeded.warnings, []);
});

test('mergeOpencodeConfig keeps an existing plugin entry in place and never duplicates it', () => {
  const original = { plugins: ['/a', join(PREFIX, 'plugin'), '/b'] };
  const { config, warnings } = mergeOpencodeConfig(original, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(warnings, []);
  assert.strictEqual(config.plugins, original.plugins, 'the untouched array keeps its identity and order');
  assert.deepEqual(config.plugins, ['/a', join(PREFIX, 'plugin'), '/b']);
});

test('mergeOpencodeConfig converts a non-array plugins value and keeps the original value', () => {
  const stringCase = mergeOpencodeConfig({ plugins: 'legacy-string' }, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(stringCase.config.plugins, ['legacy-string', join(PREFIX, 'plugin')]);
  assert.equal(stringCase.warnings.length, 1);
  assert.match(stringCase.warnings[0], /plugins was a string, not an array/);
  const numberCase = mergeOpencodeConfig({ plugins: 42 }, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.deepEqual(numberCase.config.plugins, [42, join(PREFIX, 'plugin')]);
});

test('mergeOpencodeConfig overwrites a foreign mcp.lcu with a warning and repairs a non-object mcp', () => {
  const foreign = { mcp: { lcu: { type: 'local', command: [LCU] }, rea: { type: 'local', command: ['/rea'] } } };
  const { config, warnings } = mergeOpencodeConfig(foreign, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overwriting the existing mcp.lcu entry/);
  assert.deepEqual(config.mcp.lcu, RELAY_ENTRY);
  assert.strictEqual(config.mcp.rea, foreign.mcp.rea);
  const broken = mergeOpencodeConfig({ mcp: 'garbage' }, { nodePath: NODE, prefix: PREFIX, lcuPath: LCU });
  assert.match(broken.warnings[0], /mcp was a string, not an object/);
  assert.deepEqual(broken.config.mcp, { lcu: RELAY_ENTRY });
  assert.throws(() => mergeOpencodeConfig([], { nodePath: NODE, prefix: PREFIX, lcuPath: LCU }), TypeError);
});

test('uninstallFromOpencodeConfig removes only the entries that point at this prefix', () => {
  const original = {
    other: 1,
    mcp: { lcu: RELAY_ENTRY, rea: { type: 'local', command: ['/rea'] } },
    plugins: ['/a', join(PREFIX, 'plugin'), '/b'],
  };
  const { config, warnings, removedRelay, keptRelay, removedPlugin } =
    uninstallFromOpencodeConfig(original, { prefix: PREFIX });
  assert.deepEqual(warnings, []);
  assert.equal(removedRelay, true);
  assert.equal(keptRelay, false);
  assert.equal(removedPlugin, true);
  assert.deepEqual(config, { other: 1, mcp: { rea: original.mcp.rea }, plugins: ['/a', '/b'] });
  assert.strictEqual(config.mcp.rea, original.mcp.rea);
});

test('uninstallFromOpencodeConfig keeps an mcp.lcu that points elsewhere and warns', () => {
  const original = {
    mcp: { lcu: { type: 'local', command: [LCU] } },
    plugins: [join(PREFIX, 'plugin')],
  };
  const { config, warnings, removedRelay, keptRelay, removedPlugin } =
    uninstallFromOpencodeConfig(original, { prefix: PREFIX });
  assert.equal(removedRelay, false);
  assert.equal(keptRelay, true);
  assert.equal(removedPlugin, true);
  assert.deepEqual(config.mcp.lcu, { type: 'local', command: [LCU] });
  assert.match(warnings[0], /does not point at this install/);
  const bare = uninstallFromOpencodeConfig({}, { prefix: PREFIX });
  assert.deepEqual(bare.config, {});
  assert.equal(bare.removedRelay, false);
  assert.equal(bare.removedPlugin, false);
});

// ---------------------------------------------------------------------------
// Import closure derivation — the drift guard against the real repository.
// ---------------------------------------------------------------------------

test('the import closure derivation covers exactly the deployed modules, and all of them exist', () => {
  const closure = deriveRelayClosure(REPO_RELAY);
  assert.deepEqual(
    closure.map(file => file.slice(file.lastIndexOf('/') + 1)).sort(),
    ['client.mjs', 'diagnostics.mjs', 'host-guard.mjs', 'ipc.mjs', 'relay.mjs', 'sessions.mjs', 'singleton.mjs'],
  );
  for (const file of closure) {
    assert.equal(existsSync(file), true, `${file} must exist`);
    assert.equal(isInside(REPO_ADAPTERS_DIR, file), true, `${file} must stay inside adapters/`);
  }
  const planned = planPrefixFiles(closure, { prefix: PREFIX, pluginSourceDir: REPO_PLUGIN_DIR });
  assert.equal(planned.size, closure.length + PLUGIN_FILES.length);
  // Writing nothing: verification already ran inside planPrefixFiles; run it again explicitly.
  verifyFlatLayout(planned, PREFIX);
  for (const dest of planned.keys()) assert.equal(isInside(PREFIX, dest), true);
  const relay = planned.get(join(PREFIX, 'relay.mjs'));
  assert.match(relay, /from '\.\/client\.mjs'/);
  assert.match(relay, /from '\.\/diagnostics\.mjs'/);
  assert.doesNotMatch(relay, /from '\.\.\//);
  const pluginIndex = planned.get(join(PREFIX, 'plugin', 'index.ts'));
  assert.match(pluginIndex, /from '\.\/lifecycle\.ts'/);
});

test('deriveRelayClosure follows nested and parent-level imports in a synthetic tree', () => {
  const root = makeTempDirectory('lcu-install-closure-');
  try {
    mkdirSync(join(root, 'opencode'));
    mkdirSync(join(root, 'shared'));
    writeFileSync(join(root, 'opencode', 'relay.mjs'), "import { a } from './a.mjs';\nimport { b } from '../shared/b.mjs';\n");
    writeFileSync(join(root, 'opencode', 'a.mjs'), "import { b } from '../shared/b.mjs';\n");
    writeFileSync(join(root, 'shared', 'b.mjs'), 'export const b = 1;\n');
    const closure = deriveRelayClosure(join(root, 'opencode', 'relay.mjs'));
    assert.deepEqual(closure.map(file => file.slice(file.lastIndexOf('/') + 1)), ['relay.mjs', 'a.mjs', 'b.mjs']);
    // A parent-level import means the flat deploy must flatten it.
    const planned = planPrefixFiles(closure, { prefix: join(root, 'prefix'), pluginSourceDir: REPO_PLUGIN_DIR });
    const relay = planned.get(join(root, 'prefix', 'relay.mjs'));
    assert.match(relay, /from '\.\/b\.mjs'/);
    assert.ok(planned.has(join(root, 'prefix', 'b.mjs')));
  } finally {
    removeTempDirectory(root);
  }
});

test('flattenImportsForPrefix rewrites only specifiers that would escape the prefix', () => {
  const source = [
    "import { a } from '../a.mjs';",
    "import { b } from './b.mjs';",
    "const mod = await import('../deep/c.mjs');",
    "import sdk from '@scope/pkg';",
    "import './keep.mjs';",
  ].join('\n');
  const out = flattenImportsForPrefix(source, join(PREFIX, 'relay.mjs'), PREFIX);
  assert.match(out, /from '\.\/a\.mjs'/);
  assert.match(out, /from '\.\/b\.mjs'/);
  assert.match(out, /await import\('\.\/c\.mjs'\)/);
  assert.match(out, /import sdk from '@scope\/pkg'/);
  assert.match(out, /import '\.\/keep\.mjs'/);
  assert.doesNotMatch(out, /'\.\.\//);
});

test('verifyFlatLayout accepts a closed flat layout and catches escaping or dangling imports', () => {
  const good = new Map([
    [join(PREFIX, 'a.mjs'), "import './b.mjs';"],
    [join(PREFIX, 'b.mjs'), "export const x = 1;\nimport sdk from '@scope/pkg';"],
  ]);
  verifyFlatLayout(good, PREFIX);
  assert.throws(
    () => verifyFlatLayout(new Map([...good, [join(PREFIX, 'c.mjs'), "import '../outside.mjs';"]]), PREFIX),
    /escapes the install prefix/,
  );
  assert.throws(
    () => verifyFlatLayout(new Map([...good, [join(PREFIX, 'd.mjs'), "import './missing.mjs';"]]), PREFIX),
    /does not resolve to another deployed file/,
  );
});

test('importSpecifiers and stripComments see real imports but not prose', () => {
  const source = [
    '// mentions import thing from "../not/real.mjs" in a comment',
    'import { x } from "./real.mjs";',
    'import type { T } from "../types.ts";',
    "const lazy = () => import('./lazy.mjs');",
    "export { helper } from './helper.mjs';",
    "import './side-effect.mjs';",
  ].join('\n');
  const specs = importSpecifiers(stripComments(source));
  assert.deepEqual(specs.sort(), ['../types.ts', './helper.mjs', './lazy.mjs', './real.mjs', './side-effect.mjs']);
});

// ---------------------------------------------------------------------------
// Prechecks with injected subprocesses.
// ---------------------------------------------------------------------------

test('resolveNodePath prefers the first executable candidate and falls back to process.execPath', () => {
  const root = makeTempDirectory('lcu-install-node-');
  try {
    const usable = makeExecutable(root, 'cua-node');
    assert.equal(resolveNodePath([usable]), usable);
    assert.equal(resolveNodePath([join(root, 'missing'), usable]), usable);
    const notExecutable = join(root, 'not-exec');
    writeFileSync(notExecutable, '#!/bin/sh\n');
    chmodSync(notExecutable, 0o600);
    assert.equal(resolveNodePath([notExecutable]), process.execPath);
    assert.equal(resolveNodePath([join(root, 'missing')]), process.execPath);
    assert.equal(resolveNodePath([]), process.execPath);
    assert.equal(CHATGPT_NODE_PATH, '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node');
  } finally {
    removeTempDirectory(root);
  }
});

test('checkLcu demands an executable binary whose --version prints a version', () => {
  const root = makeTempDirectory('lcu-install-lcu-');
  try {
    const script = makeExecutable(root, 'lcu');
    const exec = fakeRun({ lcuPath: script });
    assert.equal(checkLcu(script, { run: exec.run }), 'lcu 0.4.0-test');
    assert.deepEqual(exec.calls, [[script, '--version']]);
    assert.equal(checkLcu(script, { run: () => '1.2.3\nbuild 99\n' }), '1.2.3');
    const mute = join(root, 'mute');
    writeFileSync(mute, '#!/bin/sh\n');
    chmodSync(mute, 0o600);
    assert.throws(() => checkLcu(mute, { run: exec.run }), { name: 'EnvironmentError', message: /not an executable file/ });
    assert.throws(() => checkLcu(join(root, 'missing'), { run: exec.run }), { name: 'EnvironmentError', message: /not an executable file/ });
    assert.throws(
      () => checkLcu(script, { run: () => { throw Object.assign(new Error('boom'), { stdout: 'out', stderr: 'err' }); } }),
      { name: 'EnvironmentError', message: /lcu --version failed/ },
    );
    assert.throws(() => checkLcu(script, { run: () => 'hello world' }), { name: 'EnvironmentError', message: /printed no version/ });
  } finally {
    removeTempDirectory(root);
  }
});

test('compareVersions is numeric per component; garbage compares as null', () => {
  assert.equal(compareVersions('2.2', '2.2'), 0);
  assert.equal(compareVersions('2.2.0', '2.2'), 0);
  assert.equal(compareVersions('2.10.0', '2.2'), 1);
  assert.equal(compareVersions('2.1.9', '2.2'), -1);
  assert.equal(compareVersions('10.0', '9.9'), 1);
  assert.equal(compareVersions('2.2-beta', '2.2'), null);
  assert.equal(compareVersions('2.2', ''), null);
});

test('checkOpencodeVersion warns on a missing plist, blocks old versions, and accepts 2.10', () => {
  const log = recordLog();
  assert.equal(readOpencodeVersion('/missing/Info.plist', { run: () => { throw new Error('ENOENT'); } }), undefined);
  assert.equal(readOpencodeVersion('/any.plist', { run: () => '9.9.9\n' }), '9.9.9');
  assert.equal(checkOpencodeVersion({ plistPath: '/any.plist', run: () => '9.9.9\n', log }), '9.9.9');
  assert.equal(checkOpencodeVersion({ plistPath: '/missing', run: () => { throw new Error('x'); }, log }), undefined);
  assert.match(log.text('warn')[0], /version unknown/);
  assert.equal(checkOpencodeVersion({ plistPath: '/any.plist', run: () => '2.2\n', log }), '2.2');
  assert.equal(checkOpencodeVersion({ plistPath: '/any.plist', run: () => '2.10.0\n', log }), '2.10.0');
  // An unparseable version warns instead of blocking…
  log.lines.length = 0;
  assert.equal(checkOpencodeVersion({ plistPath: '/any.plist', run: () => '2.2-beta\n', log }), '2.2-beta');
  assert.match(log.text('warn')[0], /cannot be compared/);
  // …while a real older version is an environment failure.
  assert.throws(
    () => checkOpencodeVersion({ plistPath: '/any.plist', run: () => '2.1.9\n', log }),
    { name: 'EnvironmentError', message: /older than the required 2\.2/ },
  );
});

// ---------------------------------------------------------------------------
// The disk layer: config read/backup/atomic-write and the install manifest.
// ---------------------------------------------------------------------------

test('readOpencodeConfig accepts objects, refuses corrupt JSON, and tolerates a missing file', () => {
  const root = makeTempDirectory('lcu-install-cfg-');
  try {
    const configPath = join(root, 'opencode.json');
    assert.deepEqual(readOpencodeConfig(configPath), { existed: false, raw: undefined, config: {}, mode: undefined });
    const text = seedConfigText();
    writeFileSync(configPath, text, { mode: 0o600 });
    const parsed = readOpencodeConfig(configPath);
    assert.equal(parsed.existed, true);
    assert.equal(parsed.raw, text);
    assert.equal(parsed.config['模型']['嵌套'][2].深, true);
    assert.equal(parsed.mode, 0o600);
    writeFileSync(configPath, '{not json', { mode: 0o600 });
    assert.throws(() => readOpencodeConfig(configPath), { name: 'EnvironmentError', message: /refusing to overwrite it/ });
    writeFileSync(configPath, '[1, 2]', { mode: 0o600 });
    assert.throws(() => readOpencodeConfig(configPath), { name: 'EnvironmentError', message: /JSON object/ });
  } finally {
    removeTempDirectory(root);
  }
});

test('writeOpencodeConfig backs up the original and replaces the file atomically', () => {
  const root = makeTempDirectory('lcu-install-write-');
  try {
    const configPath = join(root, 'config', 'opencode.json');
    mkdirSync(join(root, 'config'));
    const original = seedConfigText();
    writeFileSync(configPath, original, { mode: 0o600 });
    const calls = [];
    const next = serializeConfig({ '中文': '值', kept: { a: 1 } });
    writeOpencodeConfig(configPath, next, {
      existed: true,
      mode: 0o600,
      rename: (from, to) => { calls.push([from, to]); renameSync(from, to); },
    });
    assert.equal(calls.length, 1);
    const [from, to] = calls[0];
    assert.equal(to, configPath);
    assert.equal(from.slice(0, from.lastIndexOf('/') + 1), configPath.slice(0, configPath.lastIndexOf('/') + 1), 'the temp file is a sibling of the target');
    assert.match(from, /\.tmp$/);
    assert.equal(readFileSync(`${configPath}${BACKUP_SUFFIX}`, 'utf8'), original, 'the backup holds the original bytes');
    const written = readFileSync(configPath, 'utf8');
    assert.equal(written, next);
    assert.deepEqual(JSON.parse(written), { '中文': '值', kept: { a: 1 } });
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'the file mode survives the replace');
    assert.equal(readdirSync(join(root, 'config')).filter(name => name.endsWith('.tmp')).length, 0, 'no temp files left behind');
    // A fresh config (nothing to back up) is created with the default mode.
    const fresh = join(root, 'fresh', 'opencode.json');
    writeOpencodeConfig(fresh, '{}\n', { existed: false });
    assert.equal(existsSync(`${fresh}${BACKUP_SUFFIX}`), false);
    assert.equal(readFileSync(fresh, 'utf8'), '{}\n');
  } finally {
    removeTempDirectory(root);
  }
});

test('manifests round-trip and only identify their own installs', () => {
  const root = makeTempDirectory('lcu-install-manifest-');
  try {
    mkdirSync(root, { recursive: true });
    const manifest = { tool: MANIFEST_TOOL, schema: MANIFEST_SCHEMA, version: INSTALLER_VERSION, installedAt: 'T0', files: ['relay.mjs'] };
    writeManifest(root, manifest);
    const read = readManifest(root);
    assert.deepEqual(read, manifest);
    assert.equal(isOwnManifest(read), true);
    writeFileSync(join(root, MANIFEST_NAME), '{broken');
    assert.equal(readManifest(root), undefined);
    assert.equal(readManifest(join(root, 'missing-dir')), undefined);
    assert.equal(isOwnManifest(undefined), false);
    assert.equal(isOwnManifest({ tool: 'someone-else', schema: 1, files: [] }), false);
    assert.equal(isOwnManifest({ tool: MANIFEST_TOOL, schema: 1 }), false, 'a manifest without a files list is not ours');
  } finally {
    removeTempDirectory(root);
  }
});

test('directoryBytes sizes a tree like du and formatBytes prints it for humans', () => {
  const root = makeTempDirectory('lcu-install-du-');
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(10));
    writeFileSync(join(root, 'sub', 'b.bin'), 'x'.repeat(100));
    symlinkSync(join(root, 'a.txt'), join(root, 'sub', 'link.txt'));
    assert.equal(directoryBytes(root), 110);
    assert.equal(formatBytes(0), '0B');
    assert.equal(formatBytes(512), '512B');
    assert.equal(formatBytes(26 * 1024 * 1024), '26.0MB');
    assert.equal(formatBytes(80 * 1024 * 1024), '80.0MB');
    assert.equal(formatBytes(2 * 1024 ** 3), '2.0GB');
  } finally {
    removeTempDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// The consent gate and the full flows.
// ---------------------------------------------------------------------------

test('install refuses to mutate without --yes when stdin is not a TTY, and runs no probes first', async () => {
  const root = makeTempDirectory('lcu-install-gate-');
  try {
    const flow = flowDeps(root);
    const log = recordLog();
    const code = await main(['--prefix', flow.prefix, '--config', flow.configPath, '--lcu', flow.lcu], {
      ...flow.deps, isTTY: () => false, log,
    });
    assert.equal(code, 1);
    assert.deepEqual(flow.exec.calls, [], 'the gate must come before any subprocess');
    const printed = log.text('info').join('\n');
    assert.match(printed, /install plan/);
    assert.ok(printed.includes(flow.configPath), 'the plan names the config it would rewrite');
    assert.ok(printed.includes(flow.prefix), 'the plan names the prefix it would fill');
    assert.match(printed, /Refusing to install without --yes/);
    assert.equal(existsSync(flow.prefix), false);
    assert.equal(existsSync(flow.configPath), false);
  } finally {
    removeTempDirectory(root);
  }
});

test('a tty confirmation decline aborts the install as well', async () => {
  const root = makeTempDirectory('lcu-install-decline-');
  try {
    const flow = flowDeps(root);
    const log = recordLog();
    let asked = '';
    const code = await main(['--prefix', flow.prefix, '--config', flow.configPath, '--lcu', flow.lcu], {
      ...flow.deps, isTTY: () => true, confirm: async question => { asked = question; return false; }, log,
    });
    assert.equal(code, 1);
    assert.match(asked, /Proceed with the install\?/);
    assert.match(log.text('info').join('\n'), /not confirmed/);
    assert.equal(existsSync(flow.prefix), false);
  } finally {
    removeTempDirectory(root);
  }
});

test('a corrupt config blocks every mutation, even with --yes', async () => {
  const root = makeTempDirectory('lcu-install-corrupt-');
  try {
    const flow = flowDeps(root);
    const log = recordLog();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(flow.configPath, '{not json');
    const code = await main(['--yes', '--prefix', flow.prefix, '--config', flow.configPath, '--lcu', flow.lcu], {
      ...flow.deps, isTTY: () => false, log,
    });
    assert.equal(code, 2);
    assert.match(log.text('error').join('\n'), /not valid JSON/);
    assert.equal(existsSync(flow.prefix), false, 'the prefix must not be deployed when the config is unreadable');
    assert.equal(readFileSync(flow.configPath, 'utf8'), '{not json');
  } finally {
    removeTempDirectory(root);
  }
});

test('full flow: install, idempotent refresh, clean uninstall', async () => {
  const root = makeTempDirectory('lcu-install-flow-');
  try {
    const flow = flowDeps(root);
    const { prefix, configPath, lcu, node, nodeModules, exec, deps } = flow;
    mkdirSync(join(root, 'config'), { recursive: true });
    const seedText = seedConfigText();
    writeFileSync(configPath, seedText);

    // --- install ---
    const installLog = recordLog();
    assert.equal(await main(['--yes', '--prefix', prefix, '--config', configPath, '--lcu', lcu], { ...deps, log: installLog }), 0);
    assert.deepEqual(exec.calls.filter(([file]) => file === lcu), [[lcu, '--version']]);
    assert.deepEqual(exec.calls.filter(([file]) => file === 'plutil')[0], ['plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', deps.plistPath]);
    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(merged.mcp.lcu, { type: 'local', command: [node, join(prefix, 'relay.mjs'), '--lcu', lcu] });
    assert.equal(merged.mcp.lcu.command[0], node, 'the resolved node path lands in the command');
    assert.deepEqual(merged.mcp.rea, JSON.parse(seedText).mcp.rea);
    assert.deepEqual(merged.plugins, ['/somewhere/else-plugin', join(prefix, 'plugin')]);
    assert.deepEqual(merged['模型'], JSON.parse(seedText)['模型']);
    assert.equal(readFileSync(`${configPath}${BACKUP_SUFFIX}`, 'utf8'), seedText);
    assert.match(installLog.text('warn').join('\n'), /overwriting the existing mcp.lcu entry/);
    // The deploy layout: relay closure, plugin trio, node_modules skeleton, manifest.
    for (const name of ['relay.mjs', 'ipc.mjs', 'sessions.mjs', 'singleton.mjs', 'client.mjs', 'diagnostics.mjs', 'host-guard.mjs']) {
      assert.equal(existsSync(join(prefix, name)), true, `${name} must be deployed`);
    }
    for (const name of PLUGIN_FILES) assert.equal(existsSync(join(prefix, 'plugin', name)), true);
    assert.match(readFileSync(join(prefix, 'relay.mjs'), 'utf8'), /from '\.\/client\.mjs'/);
    assert.equal(existsSync(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json')), true);
    assert.equal(existsSync(join(prefix, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')), true);
    const manifest = readManifest(prefix);
    assert.equal(isOwnManifest(manifest), true);
    assert.deepEqual(manifest.versions, { adapter: INSTALLER_VERSION, lcu: 'lcu 0.4.0-test', opencode: '9.9.9' });
    assert.equal(manifest.nodePath, node);
    assert.deepEqual(manifest.files, [
      'client.mjs', 'diagnostics.mjs', 'host-guard.mjs', 'ipc.mjs', 'plugin/index.ts',
      'plugin/lifecycle.ts', 'plugin/package.json', 'relay.mjs', 'sessions.mjs', 'singleton.mjs',
    ]);
    assert.match(installLog.text('info').join('\n'), /Restart OpenCode/);

    // --- refresh: idempotent, byte-identical config, no spurious overwrite warning ---
    const beforeRefresh = readFileSync(configPath, 'utf8');
    const refreshLog = recordLog();
    assert.equal(await main(['--yes', '--refresh', '--prefix', prefix, '--config', configPath, '--lcu', lcu], { ...deps, log: refreshLog }), 0);
    assert.equal(readFileSync(configPath, 'utf8'), beforeRefresh, 'a refresh must not change the config bytes');
    assert.doesNotMatch(refreshLog.text('warn').join('\n'), /overwriting/);
    assert.match(refreshLog.text('info').join('\n'), /already lists exactly this install/);
    assert.equal(readManifest(prefix).installedAt !== manifest.installedAt, true, 'the manifest is re-stamped');

    // --- uninstall ---
    const uninstallLog = recordLog();
    assert.equal(await main(['--yes', '--uninstall', '--prefix', prefix, '--config', configPath, '--lcu', lcu], { ...deps, log: uninstallLog }), 0);
    const cleaned = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(cleaned.mcp.lcu, undefined);
    assert.deepEqual(cleaned.mcp.rea, JSON.parse(seedText).mcp.rea);
    assert.deepEqual(cleaned.plugins, ['/somewhere/else-plugin']);
    assert.deepEqual(cleaned['模型'], JSON.parse(seedText)['模型']);
    assert.equal(existsSync(prefix), false, 'a manifest-backed prefix is removed');
    assert.equal(existsSync(`${configPath}${BACKUP_SUFFIX}`), true, 'the backup stays for manual recovery');

    // --- uninstall again: a peaceful no-op ---
    const againLog = recordLog();
    assert.equal(await main(['--yes', '--uninstall', '--prefix', prefix, '--config', configPath, '--lcu', lcu], { ...deps, log: againLog }), 0);
    assert.match(againLog.text('info').join('\n'), /nothing to remove/);
  } finally {
    removeTempDirectory(root);
  }
});

test('uninstall without a manifest cleans the config but keeps the prefix unless --yes', async () => {
  const root = makeTempDirectory('lcu-install-nomanifest-');
  try {
    const flow = flowDeps(root);
    const { prefix, configPath, deps } = flow;
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(configPath, seedConfigText());
    assert.equal(await main(['--yes', '--prefix', prefix, '--config', configPath, '--lcu', flow.lcu], deps), 0);
    rmSync(join(prefix, MANIFEST_NAME));

    // Confirmed on a tty, but no --yes: the config is cleaned, the prefix is kept, exit 1.
    const cautiousLog = recordLog();
    const cautious = await main(['--uninstall', '--prefix', prefix, '--config', configPath, '--lcu', flow.lcu], {
      ...deps, isTTY: () => true, confirm: async () => true, log: cautiousLog,
    });
    assert.equal(cautious, 1);
    assert.equal(existsSync(prefix), true);
    assert.match(cautiousLog.text('warn').join('\n'), /kept .*no install-manifest/);
    const cleaned = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(cleaned.mcp.lcu, undefined, 'the config cleanup still happens');

    // --yes removes the unproven prefix, loudly.
    const forcedLog = recordLog();
    assert.equal(await main(['--yes', '--uninstall', '--prefix', prefix, '--config', configPath, '--lcu', flow.lcu], { ...deps, log: forcedLog }), 0);
    assert.equal(existsSync(prefix), false);
    assert.match(forcedLog.text('warn').join('\n'), /missing \(--yes\)/);
  } finally {
    removeTempDirectory(root);
  }
});

test('uninstall keeps an mcp.lcu that points at another install and removes only its own plugin', async () => {
  const root = makeTempDirectory('lcu-install-foreign-');
  try {
    const prefix = join(root, 'prefix', 'current');
    const configPath = join(root, 'config', 'opencode.json');
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(prefix, { recursive: true });
    writeManifest(prefix, { tool: MANIFEST_TOOL, schema: 1, installedAt: 'T0', files: ['relay.mjs'] });
    const foreignCommand = { type: 'local', command: ['/other/prefix/relay.mjs', '--lcu', '/other/lcu'] };
    writeFileSync(configPath, `${JSON.stringify({
      mcp: { lcu: foreignCommand, rea: { type: 'local', command: ['/rea'] } },
      plugins: [join(prefix, 'plugin'), '/mine'],
    }, null, 2)}\n`);
    const log = recordLog();
    assert.equal(await main(['--yes', '--uninstall', '--prefix', prefix, '--config', configPath], { log }), 0);
    const cleaned = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(cleaned.mcp.lcu, foreignCommand, 'a foreign relay command survives');
    assert.deepEqual(cleaned.plugins, ['/mine']);
    assert.match(log.text('warn').join('\n'), /does not point at this install/);
    assert.equal(existsSync(prefix), false);
  } finally {
    removeTempDirectory(root);
  }
});

test('uninstall refuses to act on a corrupt config and keeps the prefix', async () => {
  const root = makeTempDirectory('lcu-install-corrupt-un-');
  try {
    const prefix = join(root, 'prefix', 'current');
    const configPath = join(root, 'config', 'opencode.json');
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(prefix, { recursive: true });
    writeManifest(prefix, { tool: MANIFEST_TOOL, schema: 1, installedAt: 'T0', files: ['relay.mjs'] });
    writeFileSync(configPath, '{broken');
    const log = recordLog();
    assert.equal(await main(['--yes', '--uninstall', '--prefix', prefix, '--config', configPath], { log }), 2);
    assert.equal(existsSync(prefix), true, 'the prefix must survive when the config cannot be read safely');
    assert.equal(readFileSync(configPath, 'utf8'), '{broken');
  } finally {
    removeTempDirectory(root);
  }
});

test('the deployed prefix actually imports and answers like the relay (real node_modules copy)', async () => {
  const root = makeTempDirectory('lcu-install-runtime-');
  try {
    const flow = flowDeps(root, { nodeModulesPath: join(REPO_ADAPTERS_DIR, 'node_modules') });
    const log = recordLog();
    assert.equal(await installAdapter({ ...flow.deps, yes: true, log }), 0);
    assert.equal(existsSync(join(flow.prefix, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')), true);
    const deployed = await import(pathToFileURL(join(flow.prefix, 'relay.mjs')).href);
    assert.equal(typeof deployed.parseRelayArgs, 'function');
    assert.deepEqual(deployed.parseRelayArgs(['--lcu', '/fixture/lcu']), { lcuPath: '/fixture/lcu' });
    assert.equal(deployed.STANDBY_TOOLS.length, 2);
    assert.deepEqual(deployed.STANDBY_TOOLS.map(tool => tool.name), ['js', 'js_reset']);
    const config = JSON.parse(readFileSync(flow.configPath, 'utf8'));
    assert.deepEqual(config, { mcp: { lcu: { type: 'local', command: [flow.node, join(flow.prefix, 'relay.mjs'), '--lcu', flow.lcu] } }, plugins: [join(flow.prefix, 'plugin')] });
  } finally {
    removeTempDirectory(root);
  }
});

// ---------------------------------------------------------------------------
// The real CLI surface: exit codes, the no-TTY gate, and usage errors, as a subprocess.
// ---------------------------------------------------------------------------

test('the CLI as a subprocess: no-TTY install prints its plan and exits 1; uninstall works', () => {
  const root = makeTempDirectory('lcu-install-cli-');
  try {
    const prefix = join(root, 'prefix', 'current');
    const configPath = join(root, 'config', 'opencode.json');
    const planned = spawnSync(process.execPath, [INSTALL_SCRIPT, '--prefix', prefix, '--config', configPath], { encoding: 'utf8' });
    assert.equal(planned.status, 1);
    assert.match(planned.stdout, /install plan/);
    assert.match(planned.stdout, /Refusing to install without --yes/);
    assert.equal(existsSync(prefix), false);

    const unknown = spawnSync(process.execPath, [INSTALL_SCRIPT, '--bogus'], { encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown install argument/);
    assert.match(unknown.stderr, /usage: node install\.mjs/);

    const combined = spawnSync(process.execPath, [INSTALL_SCRIPT, '--yes', '--uninstall', '--refresh', '--prefix', prefix, '--config', configPath], { encoding: 'utf8' });
    assert.equal(combined.status, 1);
    assert.match(combined.stderr, /cannot be combined/);

    const uninstallPlan = spawnSync(process.execPath, [INSTALL_SCRIPT, '--uninstall', '--prefix', prefix, '--config', configPath], { encoding: 'utf8' });
    assert.equal(uninstallPlan.status, 1, 'uninstall also gates on --yes without a tty');
    assert.match(uninstallPlan.stdout, /uninstall plan/);
    assert.match(uninstallPlan.stdout, /nothing installed there/);

    const uninstall = spawnSync(process.execPath, [INSTALL_SCRIPT, '--yes', '--uninstall', '--prefix', prefix, '--config', configPath], { encoding: 'utf8' });
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /nothing to remove/);
  } finally {
    removeTempDirectory(root);
  }
});