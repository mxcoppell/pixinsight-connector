// Release-metadata gate. Three files describe the same release to three channels: package.json (npm),
// server.json (the official MCP registry) and manifest.json (the MCPB bundle for Claude Desktop). They
// must agree on the version and the name, and every environment variable they offer must be one the
// connector actually reads, or a user would configure something that silently does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));

// The registry names a server `<namespace>/<name>`; GitHub authentication owns `io.github.<user>/`.
const MCP_NAME = 'io.github.mxcoppell/pixinsight-connector';
const SERVER_SCHEMA = /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/;
// A GitHub install runs these; anything needing a build step breaks the zero-touch install.
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'];

async function srcText() {
  const entries = await readdir(path.join(ROOT, 'src'), { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => path.join(e.parentPath, e.name));
  return (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n');
}

test('package.json carries the registry mcpName, the mcp keyword and no install-time script', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.mcpName, MCP_NAME);
  assert.ok(pkg.keywords.includes('mcp'));
  assert.equal(pkg.bin['pixinsight-connector'], 'src/cli.mjs');
  const scripts = INSTALL_SCRIPTS.filter((s) => pkg.scripts?.[s]);
  assert.deepEqual(scripts, [], `install-time scripts break the GitHub-direct install: ${scripts.join(', ')}`);
});

test('server.json names the mcpName, matches the package version and runs the npm package over stdio', async () => {
  const [pkg, server] = await Promise.all([readJson('package.json'), readJson('server.json')]);
  assert.match(server.$schema, SERVER_SCHEMA);
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.ok(server.description.length >= 1 && server.description.length <= 100, 'the registry caps description at 100 characters');
  assert.equal(server.repository.url, pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''));
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(npm.transport, { type: 'stdio' });
});

test('every environment variable server.json offers is optional and read by src/', async () => {
  const [server, src] = await Promise.all([readJson('server.json'), srcText()]);
  const vars = server.packages.flatMap((p) => p.environmentVariables ?? []);
  assert.ok(vars.length > 0);
  for (const v of vars) {
    assert.notEqual(v.isRequired, true, `${v.name} must be optional: the connector runs with no configuration`);
    assert.ok(v.description, `${v.name} needs a description`);
    assert.match(src, new RegExp(`\\b${v.name}\\b`), `${v.name} is not read anywhere in src/`);
  }
});

test('manifest.json matches the package name and version and starts src/cli.mjs with node', async () => {
  const [pkg, manifest] = await Promise.all([readJson('package.json'), readJson('manifest.json')]);
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, pkg.bin['pixinsight-connector']);
  assert.ok(existsSync(path.join(ROOT, manifest.server.entry_point)));
  assert.equal(manifest.server.mcp_config.command, 'node');
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${manifest.server.entry_point}`]);
  assert.equal(manifest.compatibility.runtimes.node, pkg.engines.node);
});

test('every user_config value manifest.json maps into the environment is optional, defaulted and read by src/', async () => {
  const [manifest, src] = await Promise.all([readJson('manifest.json'), srcText()]);
  const env = manifest.server.mcp_config.env ?? {};
  const config = manifest.user_config ?? {};
  assert.ok(Object.keys(env).length > 0);
  const used = new Set();
  for (const [name, value] of Object.entries(env)) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} is not read anywhere in src/`);
    const key = value.match(/^\$\{user_config\.([\w-]+)\}$/)?.[1];
    assert.ok(key, `${name} must map exactly one user_config value, got ${value}`);
    assert.ok(config[key], `${name} maps user_config.${key}, which is not declared`);
    used.add(key);
  }
  for (const [key, option] of Object.entries(config)) {
    assert.ok(used.has(key), `user_config.${key} is declared but never mapped into the environment`);
    assert.notEqual(option.required, true, `user_config.${key} must be optional: the connector runs with no configuration`);
    // An unset option with no default leaves the literal `${user_config.key}` in the environment,
    // which src/ would read as a real value. An empty default is read as unset.
    assert.equal(option.default, '', `user_config.${key} needs default "" so an unset value reaches src/ as empty`);
  }
});

test('README.md installs the published npm package', async () => {
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npm install -g pixinsight-connector\n/, 'README.md installs from npm');
  assert.match(readme, /npx -y pixinsight-connector`/, 'README.md gives the npx command');
  assert.doesNotMatch(readme, /github:mxcoppell\/pixinsight-connector/, 'README.md still installs from GitHub');
});
