'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { fsp, path, UserError } = require('../src/io.cjs');
const { openFolder, launchProcess } = require('../src/desktop.cjs');
const folder = '/home/Учитель/Документы/Симулятор экзамена/Результаты #100%';
const directory = async () => ({ isDirectory: () => true });

test('MOS folder opening prefers Dolphin and keeps the full directory in a single argument', async () => {
  const found = [], launched = [];
  assert.equal(await openFolder(folder, { platform: 'linux', stat: directory,
    find: async name => { found.push(name); return ['dolphin', 'xdg-open'].includes(name) ? '/usr/bin/' + name : null; },
    launch: async (command, args, options) => launched.push({ command, args, options }) }), true);
  assert.deepEqual(found, ['dolphin']);
  assert.deepEqual(launched, [{ command: '/usr/bin/dolphin', args: [folder], options: { waitForExit: false } }]);
});

test('other file managers retain directory arguments without MIME association', async () => {
  const launched = [];
  await openFolder(folder, { platform: 'linux', stat: directory,
    find: async name => ['thunar', 'gio'].includes(name) ? '/usr/bin/' + name : null,
    launch: async (command, args) => launched.push({ command, args }) });
  assert.deepEqual(launched, [{ command: '/usr/bin/thunar', args: [folder] }]);
});

test('fallback desktop openers receive an encoded, complete file URI', async t => {
  for (const name of ['gio', 'xdg-open']) await t.test(name, async () => {
    const launched = [], uri = pathToFileURL(folder, { windows: false }).href;
    await openFolder(folder, { platform: 'linux', stat: directory,
      find: async candidate => candidate === name ? '/usr/bin/' + name : null,
      launch: async (command, args, options) => launched.push({ command, args, options }) });
    const args = name === 'gio' ? ['open', uri] : [uri];
    assert.deepEqual(launched, [{ command: '/usr/bin/' + name, args, options: { waitForExit: name === 'gio' } }]);
    assert.equal(new URL(uri).hash, ''); assert.equal(new URL(uri).search, '');
    assert.equal(fileURLToPath(uri, { windows: false }), folder);
    assert.match(uri, /%20/); assert.match(uri, /%23/); assert.match(uri, /%25/);
  });
});

test('native macOS and Windows folder openers receive one path argument', async () => {
  for (const [platform, location, command] of [
    ['darwin', '/Users/Teacher/Симулятор экзамена/Результаты', '/usr/bin/open'],
    ['win32', 'C:\\Users\\Учитель\\Documents\\Симулятор экзамена\\Результаты', 'explorer.exe']
  ]) {
    const launched = [];
    await openFolder(location, { platform, stat: directory, launch: async (name, args) => launched.push({ name, args }) });
    assert.deepEqual(launched, [{ name: command, args: [location] }]);
  }
});

test('invalid, absent and non-directory targets never launch an opener', async () => {
  const launch = async () => assert.fail('Invalid directories must not launch');
  for (const location of ['relative/path', '', folder + '\0'])
    await assert.rejects(openFolder(location, { platform: 'linux', stat: directory, launch }), /Некорректный путь/);
  await assert.rejects(openFolder(folder, { platform: 'linux', launch,
    stat: async () => { const error = new Error('Missing'); error.code = 'ENOENT'; throw error; } }), error => error instanceof UserError && error.status === 404);
  await assert.rejects(openFolder(folder, { platform: 'linux', launch,
    stat: async () => ({ isDirectory: () => false }) }), /не является папкой/);
  await assert.rejects(openFolder(folder, { platform: 'linux', launch, stat: directory, find: async () => null }), /Не найден файловый менеджер/);
});

test('a failed selected file manager surfaces an error instead of opening a browser fallback', async () => {
  const launches = [];
  await assert.rejects(openFolder(folder, { platform: 'linux', stat: directory,
    find: async name => '/usr/bin/' + name,
    launch: async (command, args) => { launches.push({ command, args }); throw new Error('Desktop launch failure'); } }),
  error => error instanceof UserError && error.status === 503);
  assert.deepEqual(launches, [{ command: '/usr/bin/dolphin', args: [folder] }]);
});

test('desktop child processes preserve paths with spaces, Cyrillic and shell metacharacters', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-desktop-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const record = path.join(root, 'arguments.json');
  const location = folder + ' "quoted" $literal `literal` &literal';
  await launchProcess(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))", record, location], { waitForExit: true });
  assert.deepEqual(JSON.parse(await fsp.readFile(record, 'utf8')), [location]);
});

test('desktop launch errors and early nonzero exits are observed', async () => {
  await assert.rejects(launchProcess('oge-nonexistent-desktop-command', []), { code: 'ENOENT' });
  await assert.rejects(launchProcess(process.execPath, ['-e', 'process.exit(7)']), { code: 'DESKTOP_LAUNCH_EXIT', exitCode: 7 });
  await launchProcess(process.execPath, ['-e', 'process.exit(0)'], { waitForExit: true });
});
