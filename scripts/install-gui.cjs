'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { APPLICATION, TITLE, desktopEntry, isApplicationShortcut } = require('./desktop-entry.cjs');

const MANIFEST = 'SHA256SUMS.txt';
const MARKER = 'install-state.json';
const REQUIRED = ['start.sh', 'runtime/node', 'app/src/server.cjs', 'app/scripts/install-gui.cjs', 'app/scripts/desktop-entry.cjs', 'app/ui/icon.svg'];
function check(value, message) { if (!value) throw new Error(message); }
async function statMaybe(file) { try { return await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function beneath(root, file, equal = false) {
  const relative = path.relative(root, file);
  return (equal && !relative) || (!!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function plainPath(value) {
  check(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), 'Путь к папке содержит недопустимые символы.');
  return path.resolve(value);
}
function relativeName(name) {
  check(name && !/[\\\x00-\x1f\x7f]/.test(name) && !path.posix.isAbsolute(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..') && !/^[a-z]:/i.test(name), 'Некорректный путь в контрольных суммах сборки.');
  return name;
}
async function regularHandle(file) {
  const stat = await fsp.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'Сборка содержит ссылку или неподдерживаемый файл: ' + path.basename(file));
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { check((await handle.stat()).isFile(), 'Ожидался обычный файл сборки.'); return handle; }
  catch (error) { await handle.close(); throw error; }
}
async function regularBytes(file) {
  const handle = await regularHandle(file);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function digest(file) {
  const handle = await regularHandle(file);
  const stream = handle.createReadStream({ autoClose:false });
  try {
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  } finally { stream.destroy(); await handle.close(); }
}
async function readManifest(root) {
  root = plainPath(path.resolve(root));
  const stat = await fsp.lstat(root);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Распакуйте сборку в обычную папку.');
  const raw = await regularBytes(path.join(root, MANIFEST));
  check(raw.length <= 1024 * 1024, 'Файл контрольных сумм слишком большой.');
  const entries = [], seen = new Set();
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    check(match, 'Некорректный файл контрольных сумм сборки.');
    const name = relativeName(match[2]);
    check(name !== MANIFEST && !seen.has(name), 'Повторяющийся файл в контрольных суммах сборки.');
    seen.add(name); entries.push({ name, hash:match[1] });
  }
  check(entries.length && REQUIRED.every(name => seen.has(name)), 'Сборка неполная. Распакуйте архив приложения целиком.');
  return { root, raw, entries, hash:createHash('sha256').update(raw).digest('hex') };
}
async function verifyBundle(root, expected) {
  const manifest = await readManifest(root);
  if (expected) check(manifest.hash === expected.hash, 'Контрольные суммы сборки изменились во время установки.');
  const inventory = [];
  async function walk(dir, prefix = '') {
    for (const name of await fsp.readdir(dir)) {
      const relative = relativeName(prefix + name), file = path.join(dir, name), stat = await fsp.lstat(file);
      check(!stat.isSymbolicLink(), 'Сборка содержит символическую ссылку: ' + relative);
      if (stat.isDirectory()) await walk(file, relative + '/');
      else { check(stat.isFile(), 'Сборка содержит неподдерживаемый файл: ' + relative); if (relative !== MANIFEST) inventory.push(relative); }
    }
  }
  await walk(manifest.root);
  check(JSON.stringify(inventory.sort()) === JSON.stringify(manifest.entries.map(entry => entry.name).sort()), 'Состав сборки не совпадает с контрольными суммами.');
  for (const entry of manifest.entries) check(await digest(path.join(manifest.root, ...entry.name.split('/'))) === entry.hash, 'Повреждён файл сборки: ' + entry.name);
  return manifest;
}

async function directoryPath(home, destination, create = false) {
  destination = plainPath(destination);
  check(beneath(home, destination, true), 'Установка разрешена только в папки текущего пользователя.');
  let current = home;
  for (const segment of path.relative(home, destination).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await statMaybe(current);
    if (!stat && create) { await fsp.mkdir(current, { mode:0o700 }); stat = await fsp.lstat(current); }
    if (!stat) break;
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'Папка установки содержит ссылку или конфликтующий файл: ' + current);
  }
}
function desktopDirectory(home) {
  try {
    const result = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '');
    // $HOME means the desktop directory has been disabled by the user.
    if (path.resolve(result) === home) return null;
    if (path.isAbsolute(result)) return result;
  } catch {}
  return path.join(home, 'Desktop');
}
async function previousShortcut(file) {
  const stat = await statMaybe(file);
  if (!stat) return null;
  check(stat.isFile() && !stat.isSymbolicLink(), 'Нельзя заменить ссылку или папку вместо ярлыка: ' + file);
  const contents = await regularBytes(file);
  check(isApplicationShortcut(contents.toString('utf8')), 'В папке уже есть другой ярлык с таким именем: ' + file);
  return { contents, mode:stat.mode & 0o777 };
}
async function atomicFile(file, contents, mode) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    const handle = await fsp.open(temporary, 'wx', mode);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await fsp.chmod(temporary, mode); await fsp.rename(temporary, file);
  } finally { await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function currentRelease(installRoot, releasesRoot) {
  const file = path.join(installRoot, 'current'), stat = await statMaybe(file);
  if (!stat) return null;
  check(stat.isSymbolicLink(), 'Путь current занят другим файлом или папкой.');
  const target = path.resolve(installRoot, await fsp.readlink(file));
  check(path.dirname(target) === releasesRoot && /^[a-f0-9]{20}$/.test(path.basename(target)), 'Ссылка current указывает за пределы приложения.');
  const targetStat = await fsp.lstat(target);
  check(targetStat.isDirectory() && !targetStat.isSymbolicLink(), 'Установленная версия содержит некорректную ссылку.');
  return target;
}
async function copyRegular(source, target) {
  const input = await regularHandle(source), mode = (await input.stat()).mode & 0o777;
  let output, reader, writer;
  try {
    await fsp.mkdir(path.dirname(target), { recursive:true, mode:0o700 });
    output = await fsp.open(target, 'wx', mode);
    reader = input.createReadStream({ autoClose:false }); writer = output.createWriteStream({ autoClose:false });
    await pipeline(reader, writer);
    await output.sync(); await fsp.chmod(target, mode);
  } finally { reader?.destroy(); writer?.destroy(); await input.close(); if (output) await output.close(); }
}
async function lockFingerprint(pid) {
  if (process.platform !== 'linux') return String(pid);
  try {
    const boot = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await fsp.readFile('/proc/' + pid + '/stat', 'utf8');
    return boot + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function acquireLock(installRoot) {
  const file = path.join(installRoot, 'install.lock'), nonce = randomUUID();
  const temporary = path.join(installRoot, '.install-lock-' + nonce);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ pid:process.pid, fingerprint:await lockFingerprint(process.pid), nonce })); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Linking a fully written file publishes the lock in one operation;
        // another double click cannot observe partially written JSON.
        await fsp.link(temporary, file);
      return async () => {
        const lock = JSON.parse((await regularBytes(file)).toString('utf8'));
        check(lock.nonce === nonce, 'Блокировка установщика была заменена.'); await fsp.unlink(file);
      };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const old = JSON.parse((await regularBytes(file)).toString('utf8'));
        check(Number.isInteger(old.pid) && old.pid > 0 && typeof old.fingerprint === 'string', 'Повреждена блокировка установщика.');
        let alive = true; try { process.kill(old.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; else throw probe; }
        if (alive && await lockFingerprint(old.pid) === old.fingerprint) throw new Error('Установка уже выполняется. Дождитесь её завершения.');
        await fsp.unlink(file);
      }
    }
    throw new Error('Не удалось начать установку. Повторите попытку.');
  } finally { await fsp.unlink(temporary); }
}

async function installBundle(sourceRoot, options = {}) {
  const manifest = await verifyBundle(sourceRoot);
  const home = await fsp.realpath(plainPath(options.home || os.homedir()));
  const dataHome = plainPath(options.dataHome || process.env.XDG_DATA_HOME || path.join(home, '.local/share'));
  const selectedDesktop = options.desktopDir === undefined ? desktopDirectory(home) : options.desktopDir;
  const desktopDir = selectedDesktop === null ? null : plainPath(selectedDesktop);
  const desktopEnabled = desktopDir && desktopDir !== home;
  const installRoot = path.join(home, '.local/opt', APPLICATION), releasesRoot = path.join(installRoot, 'releases');
  const releaseRoot = path.join(releasesRoot, manifest.hash.slice(0, 20)), currentRoot = path.join(installRoot, 'current');
  const menuDir = path.join(dataHome, 'applications'), dataRoot = path.join(dataHome, APPLICATION);
  const menuFile = path.join(menuDir, APPLICATION + '.desktop');
  const desktopFile = desktopEnabled ? path.join(desktopDir, APPLICATION + '.desktop') : null;
  for (const destination of [installRoot, menuDir, ...(desktopEnabled ? [desktopDir] : [])]) {
    check(!beneath(dataRoot, destination, true) && !beneath(destination, dataRoot, true), 'Папка установки не должна пересекаться с данными экзамена.');
    await directoryPath(home, destination);
  }
  check(!desktopEnabled || (!beneath(installRoot, desktopDir, true) && !beneath(desktopDir, installRoot, true)), 'Папка рабочего стола пересекается с папкой приложения.');
  const markerFile = path.join(installRoot, MARKER), markerStat = await statMaybe(markerFile), installStat = await statMaybe(installRoot);
  if (markerStat) {
    const marker = JSON.parse((await regularBytes(markerFile)).toString('utf8'));
    check(marker.schema === 1 && marker.application === APPLICATION, 'Папка установки занята другим приложением.');
  } else if (installStat) check((await fsp.readdir(installRoot)).length === 0, 'Папка установки уже существует и не принадлежит этому установщику.');
  await directoryPath(home, releasesRoot);
  await currentRelease(installRoot, releasesRoot);
  for (const file of [menuFile, desktopFile].filter(Boolean)) await previousShortcut(file);
  for (const destination of [releasesRoot, menuDir, ...(desktopEnabled ? [desktopDir] : [])]) await directoryPath(home, destination, true);
  if (!markerStat) await atomicFile(markerFile, JSON.stringify({ schema:1, application:APPLICATION }) + '\n', 0o600);
  const releaseLock = await acquireLock(installRoot);
  try {
    const previousRoot = await currentRelease(installRoot, releasesRoot), shortcuts = [];
    for (const file of [menuFile, desktopFile].filter(Boolean)) shortcuts.push({ file, before:await previousShortcut(file), mode:file === menuFile ? 0o644 : 0o755 });
    let reused = false;
    const existing = await statMaybe(releaseRoot);
    if (existing) { await verifyBundle(releaseRoot, manifest); reused = true; }
    else {
      // Existing releases stay untouched, including a running Node binary.
      const staging = path.join(releasesRoot, '.install-' + randomUUID());
      await fsp.mkdir(staging, { mode:0o700 });
      try {
        for (const entry of manifest.entries) await copyRegular(path.join(manifest.root, ...entry.name.split('/')), path.join(staging, ...entry.name.split('/')));
        await fsp.writeFile(path.join(staging, MANIFEST), manifest.raw, { flag:'wx', mode:0o644 });
        await verifyBundle(staging, manifest);
        for (const name of ['start.sh', 'runtime/node']) await fsp.chmod(path.join(staging, name), 0o755);
        await fsp.rename(staging, releaseRoot);
      } finally {
        check(beneath(releasesRoot, staging), 'Некорректная временная папка установки.');
        await fsp.rm(staging, { recursive:true, force:true });
      }
    }
    const contents = desktopEntry(currentRoot), written = [], next = path.join(installRoot, '.current-' + randomUUID());
    try {
      for (const shortcut of shortcuts) {
        if (shortcut.before?.contents.toString('utf8') === contents && shortcut.before.mode === shortcut.mode) continue;
        await atomicFile(shortcut.file, contents, shortcut.mode); written.push(shortcut);
      }
      if (previousRoot !== releaseRoot) {
        // Junctions allow first-install fixture tests on Windows without admin.
        // Supported installation/update platform is Linux (atomic symlink rename).
        await fsp.symlink(process.platform === 'win32' ? releaseRoot : path.relative(installRoot, releaseRoot), next, process.platform === 'win32' ? 'junction' : 'dir');
        await fsp.rename(next, currentRoot);
      }
    } catch (error) {
      for (const shortcut of written.reverse()) {
        if (shortcut.before) await atomicFile(shortcut.file, shortcut.before.contents, shortcut.before.mode);
        else await fsp.unlink(shortcut.file);
      }
      throw error;
    } finally { await fsp.unlink(next).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { installRoot, releaseRoot, currentRoot, menuFile, desktopFile, manifestHash:manifest.hash, reused };
  } finally { await releaseLock(); }
}

function dialog(args) {
  const result = spawnSync('kdialog', ['--title', TITLE, ...args], { stdio:['ignore', 'pipe', 'pipe'], shell:false });
  if (result.error) throw new Error('Не удалось открыть окно установки: требуется KDialog.');
  check(result.status === 0 || result.status === 1, 'Не удалось открыть окно установки.');
  return result.status === 0;
}
async function launch(root) {
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, 'start.sh'), [], { detached:true, stdio:'ignore', shell:false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function main(sourceRoot = path.resolve(__dirname, '../..')) {
  try {
    check(process.platform === 'linux' && process.arch === 'x64', 'Эта сборка предназначена для MOS ОС, Linux x86_64.');
    check(!process.getuid || process.getuid() !== 0, 'Запустите установщик от обычного пользователя.');
    if (!dialog(['--yes-label', 'Установить', '--no-label', 'Отмена', '--yesno', 'Установить приложение для текущего пользователя?'])) return;
    const installed = await installBundle(sourceRoot);
    const message = installed.desktopFile ? 'Приложение установлено.\nЯрлыки добавлены на рабочий стол и в меню приложений.' : 'Приложение установлено.\nЯрлык добавлен в меню приложений.';
    if (dialog(['--yes-label', 'Запустить', '--no-label', 'Закрыть', '--yesno', message])) await launch(installed.currentRoot);
  } catch (error) {
    try { dialog(['--error', 'Не удалось установить приложение.\n' + error.message]); }
    catch { console.error(error.message); }
    process.exitCode = 1;
  }
}
module.exports = { readManifest, verifyBundle, installBundle, desktopDirectory, main };
if (require.main === module) main(process.argv[2]);
