'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
async function exists(file) {
  try { return await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(dir, create = false) {
  const absolute = path.resolve(dir), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await exists(current);
    if (!stat && create) {
      try { await fsp.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await exists(current);
    }
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('ENOTDIR', `Небезопасная папка результатов: ${current}`);
  }
  return true;
}
async function content(file, onChunk) {
  const stat = await exists(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw failure('EINVAL', `Ожидался обычный файл результатов: ${file}`);
  const input = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw failure('ESTALE', `Файл результатов изменился: ${file}`);
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); size += bytesRead;
      if (onChunk) await onChunk(chunk);
    }
    return { type: 'file', size, sha256: hash.digest('hex') };
  } finally { await input.close(); }
}
function same(a, b) { return a?.type === b?.type && (a.type === 'directory' || (a.size === b.size && a.sha256 === b.sha256)); }
async function inventory(root, source) {
  const entries = new Map();
  async function walk(dir, prefix = '') {
    const names = (await fsp.readdir(dir)).sort();
    for (const name of names) {
      const file = path.join(dir, name), relative = `${prefix}${name}`, stat = await exists(file);
      if (!stat) throw failure('ESTALE', `Файл результатов исчез: ${file}`);
      if (name.startsWith('.') || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        if (source) continue;
        return false;
      }
      if (stat.isDirectory()) {
        entries.set(relative, { type: 'directory' });
        if (!await walk(file, `${relative}/`)) return false;
      } else entries.set(relative, await content(file));
    }
    return true;
  }
  return await walk(root) ? entries : null;
}
async function compatible(dir, zip, group) {
  const dirStat = await exists(dir), zipStat = await exists(zip);
  if (dirStat) {
    if (!group.entries || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    const present = await inventory(dir, false);
    if (!present || [...present].some(([name, info]) => !same(info, group.entries.get(name)))) return false;
  }
  if (zipStat) {
    if (!group.zip || zipStat.isSymbolicLink() || !zipStat.isFile() || !same(await content(zip), group.zip)) return false;
  }
  return true;
}
async function copyFile(source, target, expected, staging) {
  const present = await exists(target);
  if (present) {
    if (!present.isSymbolicLink() && present.isFile() && same(await content(target), expected)) return;
    throw failure('EEXIST', `Не удалось сохранить результат без перезаписи: ${target}`);
  }
  const temporary = path.join(staging, crypto.randomUUID()), output = await fsp.open(temporary, 'wx', 0o600);
  try {
    const copied = await content(source, async chunk => { await output.writeFile(chunk); });
    if (!same(copied, expected)) throw failure('ESTALE', `Файл результатов изменился при копировании: ${source}`);
    await output.sync();
  } finally { await output.close(); }
  try {
    // A hard link publishes a fully written file atomically and cannot replace an existing file.
    // Staging is on the destination filesystem; an interrupted pair is completed on the next run.
    try { await fsp.link(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await exists(target);
      if (!current || current.isSymbolicLink() || !current.isFile() || !same(await content(target), expected)) throw error;
    }
  } finally { await fsp.unlink(temporary); }
}

async function migrateLegacyResults(legacyRoot, targetRoot) {
  const source = path.resolve(legacyRoot), target = path.resolve(targetRoot), paths = new Map();
  if (!await directory(source)) return paths;
  for (const [a, b] of [[source, target], [target, source]]) {
    const rel = path.relative(a, b);
    if (rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) {
      throw failure('EINVAL', 'Папки старых и новых результатов не должны быть вложены друг в друга.');
    }
  }
  const groups = new Map();
  for (const name of (await fsp.readdir(source)).sort()) {
    if (!name.startsWith('OGE_') || name.endsWith('.tmp')) continue;
    const file = path.join(source, name), stat = await exists(file);
    if (!stat) throw failure('ESTALE', `Результат экзамена исчез: ${file}`);
    if (stat.isSymbolicLink()) continue;
    const isZip = stat.isFile() && name.endsWith('.zip');
    if (!isZip && (!stat.isDirectory() || name.endsWith('.zip'))) continue;
    const stem = isZip ? name.slice(0, -4) : name;
    if (stem.endsWith('.tmp')) continue;
    const group = groups.get(stem) || { stem, entries: null, zip: null };
    if (isZip) group.zip = await content(file);
    else group.entries = await inventory(file, true);
    groups.set(stem, group);
  }
  if (!groups.size) return paths;
  await directory(target, true);
  const staging = await fsp.mkdtemp(path.join(target, '.oge-results-migration-'));
  try {
    for (const group of groups.values()) {
      const digest = crypto.createHash('sha256').update(JSON.stringify({ entries: group.entries && [...group.entries], zip: group.zip })).digest('hex').slice(0, 16);
      let destination;
      // Matching subsets are an interrupted migration, not a collision. Never replace other data.
      for (let counter = 0; counter < 10000; counter++) {
        const stem = counter === 0 ? group.stem : `${group.stem}_${digest}${counter > 1 ? `_${counter}` : ''}`;
        const dir = path.join(target, stem), zip = `${dir}.zip`;
        if (await compatible(dir, zip, group)) { destination = { dir, zip }; break; }
      }
      if (!destination) throw failure('EEXIST', 'Не удалось выбрать свободное имя результата экзамена.');
      if (group.entries) {
        await directory(destination.dir, true);
        for (const [relative, info] of group.entries) {
          const file = path.join(destination.dir, ...relative.split('/'));
          if (info.type === 'directory') await directory(file, true);
          else {
            await directory(path.dirname(file), true);
            await copyFile(path.join(source, group.stem, ...relative.split('/')), file, info, staging);
          }
        }
      }
      if (group.zip) await copyFile(path.join(source, `${group.stem}.zip`), destination.zip, group.zip, staging);
      if (group.entries) paths.set(path.join(source, group.stem), destination.dir);
      if (group.zip) paths.set(path.join(source, `${group.stem}.zip`), destination.zip);
    }
    return paths;
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}

module.exports = { migrateLegacyResults };
