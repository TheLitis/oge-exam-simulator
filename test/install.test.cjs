'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { installBundle, readManifest, verifyBundle } = require('../scripts/install-gui.cjs');
const { APPLICATION, TITLE, execArgument, desktopEntry } = require('../scripts/desktop-entry.cjs');
const sum = value => createHash('sha256').update(value).digest('hex');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function manifest(root) {
  const entries = [];
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
      const name = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, name + '/');
      else if (name !== 'SHA256SUMS.txt') entries.push(sum(await fs.readFile(file)) + '  ' + name);
    }
  }
  await walk(root); await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), entries.sort().join('\n') + '\n');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oge-install-test-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'oge-install-test-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  let home = path.join(root, "Ученик с пробелом % $ '");
  const source = path.join(root, 'Сборка с пробелом %'), files = {
    'start.sh':'#!/bin/sh\nprintf fixture\n', 'runtime/node':'fixture-runtime-one\n',
    'app/src/server.cjs':'console.log("fixture-one");\n',
    'app/scripts/install-gui.cjs':'// installer fixture\n',
    'app/scripts/desktop-entry.cjs':'// desktop fixture\n', 'app/ui/icon.svg':'<svg/>\n',
    'app/readme с пробелом %.txt':'Fixture document\n'
  };
  await fs.mkdir(home); home = await fs.realpath(home);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(source, ...name.split('/')); await fs.mkdir(path.dirname(file), { recursive:true }); await fs.writeFile(file, contents);
  }
  await fs.chmod(path.join(source, 'start.sh'), 0o755); await fs.chmod(path.join(source, 'runtime/node'), 0o755); await manifest(source);
  const dataHome = path.join(home, '.local/share'), desktopDir = path.join(home, 'Рабочий стол'), dataRoot = path.join(dataHome, APPLICATION);
  const preserved = { 'config.json':'{"attemptId":"keep"}', 'sessions/active/session.json':'{"status":"active"}', 'results/exam.zip':'unchanged-result-bytes' };
  for (const [name, contents] of Object.entries(preserved)) {
    const file = path.join(dataRoot, ...name.split('/')); await fs.mkdir(path.dirname(file), { recursive:true }); await fs.writeFile(file, contents);
  }
  async function unchanged() { for (const [name, contents] of Object.entries(preserved)) assert.equal(await fs.readFile(path.join(dataRoot, ...name.split('/')), 'utf8'), contents); }
  return { root, home, source, dataHome, desktopDir, dataRoot, options:{ home, dataHome, desktopDir }, unchanged };
}

test('user installation survives moving the original bundle and leaves all exam data unchanged', async t => {
  const f = await fixture(t), installed = await installBundle(f.source, f.options);
  assert.equal(installed.reused, false); assert.equal(path.basename(installed.releaseRoot), installed.manifestHash.slice(0, 20));
  assert.equal(await fs.realpath(installed.currentRoot), await fs.realpath(installed.releaseRoot));
  await verifyBundle(installed.currentRoot).catch(error => {
    // verifyBundle deliberately rejects root symlinks: validate its resolved release.
    assert.match(error.message, /обычную папку/);
  });
  await fs.rename(f.source, path.join(f.root, 'Перемещённый исходный архив'));
  await verifyBundle(installed.releaseRoot);
  for (const shortcut of [installed.menuFile, installed.desktopFile]) {
    const contents = await fs.readFile(shortcut, 'utf8'); assert.equal(contents.includes(f.source), false); assert.equal(contents, desktopEntry(installed.currentRoot));
    assert.match(contents, /^Terminal=false$/m); assert.match(contents, /^X-OGE-Application=oge-exam-simulator$/m);
  }
  assert.throws(() => execArgument('bad\0value'));
  assert.equal(await fs.readFile(path.join(installed.currentRoot, 'app/src/server.cjs'), 'utf8'), 'console.log("fixture-one");\n');
  await f.unchanged();
});
test('reinstall reuses the verified release without rewriting its runtime or producing duplicate shortcuts', async t => {
  const f = await fixture(t), first = await installBundle(f.source, f.options);
  const before = await fs.stat(path.join(first.releaseRoot, 'runtime/node'));
  const second = await installBundle(f.source, f.options), after = await fs.stat(path.join(first.releaseRoot, 'runtime/node'));
  assert.equal(second.reused, true); assert.equal(second.releaseRoot, first.releaseRoot); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(f.desktopDir), [APPLICATION + '.desktop']);
  assert.deepEqual(await fs.readdir(path.join(first.installRoot, 'releases')), [path.basename(first.releaseRoot)]); await f.unchanged();
});
test('Linux update atomically switches current and keeps the old open runtime and exam data intact', { skip:process.platform !== 'linux' }, async t => {
  const f = await fixture(t), first = await installBundle(f.source, f.options), openRuntime = await fs.open(path.join(first.releaseRoot, 'runtime/node'));
  try {
    await fs.writeFile(path.join(f.source, 'runtime/node'), 'fixture-runtime-two\n');
    await fs.writeFile(path.join(f.source, 'app/src/server.cjs'), 'console.log("fixture-two");\n'); await manifest(f.source);
    const updated = await installBundle(f.source, f.options);
    assert.notEqual(updated.releaseRoot, first.releaseRoot); assert.equal(await fs.realpath(updated.currentRoot), updated.releaseRoot);
    assert.equal(await openRuntime.readFile('utf8'), 'fixture-runtime-one\n'); await verifyBundle(first.releaseRoot); await verifyBundle(updated.releaseRoot);
    assert.equal((await fs.readdir(path.join(first.installRoot, 'releases'))).length, 2); await f.unchanged();
  } finally { await openRuntime.close(); }
});
test('Linux reinstall restores a missing execute permission on the desktop shortcut', { skip:process.platform !== 'linux' }, async t => {
  const f = await fixture(t), first = await installBundle(f.source, f.options);
  await fs.chmod(first.desktopFile, 0o644);
  const reinstalled = await installBundle(f.source, f.options);
  assert.equal((await fs.stat(reinstalled.desktopFile)).mode & 0o777, 0o755); await f.unchanged();
});
test('corrupted, missing or unlisted source files fail before writing an installation', async t => {
  for (const kind of ['corrupt', 'missing', 'extra']) {
    const f = await fixture(t);
    if (kind === 'corrupt') await fs.writeFile(path.join(f.source, 'runtime/node'), 'modified');
    if (kind === 'missing') await fs.unlink(path.join(f.source, 'runtime/node'));
    if (kind === 'extra') await fs.writeFile(path.join(f.source, 'unlisted.txt'), 'extra');
    await assert.rejects(installBundle(f.source, f.options));
    await assert.rejects(fs.access(path.join(f.home, '.local/opt', APPLICATION))); await f.unchanged();
  }
});
test('manifest rejects traversal, absolute paths, backslashes, duplicate entries and incomplete bundles', async t => {
  for (const kind of ['../escape', '/tmp/escape', 'C:/escape', 'app\\escape', 'duplicate', 'incomplete']) {
    const f = await fixture(t), file = path.join(f.source, 'SHA256SUMS.txt'), contents = await fs.readFile(file, 'utf8');
    if (kind === 'duplicate') await fs.writeFile(file, contents + contents.split('\n')[0] + '\n');
    else if (kind === 'incomplete') await fs.writeFile(file, contents.split('\n').filter(line => !line.endsWith('  runtime/node')).join('\n'));
    else await fs.writeFile(file, contents + '0'.repeat(64) + '  ' + kind + '\n');
    await assert.rejects(readManifest(f.source)); await f.unchanged();
  }
});
test('source directory links and destination ancestor links are rejected without touching their targets', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
  const sourceLink = path.join(f.source, 'app/link'); await fs.symlink(outside, sourceLink, linkType);
  await assert.rejects(installBundle(f.source, f.options), /ссылку/); await fs.unlink(sourceLink);
  await fs.symlink(outside, path.join(f.home, '.local/opt'), linkType);
  await assert.rejects(installBundle(f.source, f.options), /ссылку/);
  assert.deepEqual(await fs.readdir(outside), ['sentinel']); await f.unchanged();
});
test('current links outside managed releases and corrupted installed releases cannot be reused', async t => {
  const f = await fixture(t), installed = await installBundle(f.source, f.options), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.unlink(installed.currentRoot); await fs.symlink(outside, installed.currentRoot, linkType);
  await assert.rejects(installBundle(f.source, f.options), /пределы/); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(installed.currentRoot); await fs.symlink(installed.releaseRoot, installed.currentRoot, linkType);
  await fs.writeFile(path.join(installed.releaseRoot, 'runtime/node'), 'tampered');
  await assert.rejects(installBundle(f.source, f.options), /Повреждён/); await f.unchanged();
});
test('an unrelated shortcut is preserved and the legacy desktop shortcut is migrated in place', async t => {
  const foreign = await fixture(t), foreignFile = path.join(foreign.dataHome, 'applications', APPLICATION + '.desktop');
  await fs.mkdir(path.dirname(foreignFile)); await fs.writeFile(foreignFile, '[Desktop Entry]\nType=Application\nName=Other application\nExec=/bin/true\n');
  await assert.rejects(installBundle(foreign.source, foreign.options), /другой ярлык/);
  assert.match(await fs.readFile(foreignFile, 'utf8'), /Other application/); await foreign.unchanged();
  const f = await fixture(t); await fs.mkdir(f.desktopDir);
  const oldFile = path.join(f.desktopDir, APPLICATION + '.desktop');
  await fs.writeFile(oldFile, `[Desktop Entry]\nType=Application\nName=${TITLE}\nExec="/old extracted folder/start.sh"\nTerminal=false\n`);
  const installed = await installBundle(f.source, f.options);
  assert.equal(installed.desktopFile, oldFile); assert.deepEqual(await fs.readdir(f.desktopDir), [APPLICATION + '.desktop']); assert.equal(await fs.readFile(oldFile, 'utf8'), desktopEntry(installed.currentRoot)); await f.unchanged();
});
test('disabled desktop installation writes only the menu shortcut and never places a launcher in home', async t => {
  const f = await fixture(t), installed = await installBundle(f.source, { ...f.options, desktopDir:f.home });
  assert.equal(installed.desktopFile, null); await fs.access(installed.menuFile);
  await assert.rejects(fs.access(path.join(f.home, APPLICATION + '.desktop'))); await assert.rejects(fs.access(f.desktopDir)); await f.unchanged();
});
test('overlapping exam-data destinations and directories belonging to another application are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(installBundle(f.source, { ...f.options, desktopDir:f.dataRoot }), /данными экзамена/);
  const installRoot = path.join(f.home, '.local/opt', APPLICATION); await fs.mkdir(installRoot, { recursive:true }); await fs.writeFile(path.join(installRoot, 'foreign-file'), 'keep');
  await assert.rejects(installBundle(f.source, f.options), /не принадлежит/); assert.equal(await fs.readFile(path.join(installRoot, 'foreign-file'), 'utf8'), 'keep'); await f.unchanged();
});
test('stale installer PID fingerprints are recovered and an extra concurrent install cannot alter exam data', async t => {
  const f = await fixture(t), installed = await installBundle(f.source, f.options), lock = path.join(installed.installRoot, 'install.lock');
  await fs.writeFile(lock, JSON.stringify({ pid:process.pid, fingerprint:'stale-boot-start', nonce:'stale' }));
  assert.equal((await installBundle(f.source, f.options)).reused, true); await assert.rejects(fs.access(lock));
  const outcomes = await Promise.allSettled([installBundle(f.source, f.options), installBundle(f.source, f.options)]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled'));
  for (const result of outcomes) if (result.status === 'rejected') assert.match(result.reason.message, /Установка уже выполняется/);
  await assert.rejects(fs.access(lock)); await verifyBundle(installed.releaseRoot); await f.unchanged();
});
