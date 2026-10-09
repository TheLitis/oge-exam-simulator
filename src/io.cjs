'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const JSZip = require('../vendor/jszip.cjs');
const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ file: 128 * MiB, image: 16 * MiB, archive: 256 * MiB, expanded: 512 * MiB, entries: 400, json: MiB });
class UserError extends Error { constructor(message, status = 400) { super(message); this.name = 'UserError'; this.status = status; } }
const check = (condition, message) => { if (!condition) throw new UserError(message); };
async function mkdir(dir) { await fsp.mkdir(dir, { recursive: true, mode: 0o700 }); }
async function syncDir(dir) {
  if (process.platform === 'win32') return;
  let h; try { h = await fsp.open(dir, 'r'); await h.sync(); } finally { await h?.close(); }
}
async function atomic(file, data, backup = false) {
  await mkdir(path.dirname(file));
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync(); await handle.close(); handle = null;
    if (backup) {
      try { await fsp.copyFile(file, `${file}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await fsp.rename(tmp, file);
    await syncDir(path.dirname(file));
  } finally { await handle?.close(); await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
async function json(file, data, backup = false) { await atomic(file, JSON.stringify(data, null, 2), backup); }
async function readJson(file, backup = false) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) {
    if (backup) { try { return JSON.parse(await fsp.readFile(`${file}.bak`, 'utf8')); } catch {} }
    throw e;
  }
}
function safeName(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 180, 'Недопустимое имя файла.');
  check(!/[\\/\x00-\x1f\x7f<>:"|?*]/u.test(value) && !/^[. ]|[. ]$/u.test(value), 'Имя файла содержит запрещённые символы.');
  check(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value), 'Недопустимое имя файла.');
  return value;
}
function safeRelative(value) {
  check(typeof value === 'string' && /^(?:manifest\.json|assets\/[a-f0-9-]{36}\.(?:png|jpg|jpeg|gif|webp|bmp|bin))$/.test(value), 'Недопустимый путь внутри экзамена.');
  return value;
}
function inside(root, rel) {
  const result = path.resolve(root, rel);
  check(result.startsWith(path.resolve(root) + path.sep), 'Недопустимый путь.');
  return result;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const buf of fs.createReadStream(file)) hash.update(buf);
  return hash.digest('hex');
}
async function boundedCopy(input, out, limit = LIMITS.file) {
  await mkdir(path.dirname(out));
  let size = 0; const hash = crypto.createHash('sha256');
  const counter = new Transform({ transform(chunk, _enc, cb) {
    size += chunk.length;
    if (size > limit) return cb(new UserError(`Файл превышает допустимый размер (${Math.floor(limit / MiB)} МБ).`, 413));
    hash.update(chunk); cb(null, chunk);
  }});
  try {
    await pipeline(input, counter, fs.createWriteStream(out, { flags: 'wx', mode: 0o600 }));
    const h = await fsp.open(out, 'r+'); try { await h.sync(); } finally { await h.close(); }
    return { size, sha256: hash.digest('hex') };
  } catch (e) { await fsp.rm(out, { force: true }).catch(() => {}); throw e; }
}
// Own package format uses ASCII UUID paths, not arbitrary ZIP names. Inspect the
// central directory BEFORE inflation so forged sizes / zip bombs cannot allocate
// unbounded memory. ZIP64, split archives, encrypted files and symlinks are rejected.
function preflightZip(buf) {
  check(Buffer.isBuffer(buf) && buf.length >= 22 && buf.length <= LIMITS.archive, 'Некорректный или слишком большой архив.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  check(eocd >= 0, 'Не найден каталог ZIP.');
  const count = buf.readUInt16LE(eocd + 10), start = buf.readUInt32LE(eocd + 16), size = buf.readUInt32LE(eocd + 12);
  check(buf.readUInt16LE(eocd + 4) === 0 && buf.readUInt16LE(eocd + 6) === 0 && buf.readUInt16LE(eocd + 8) === count, 'Многотомные ZIP не поддерживаются.');
  check(count > 0 && count <= LIMITS.entries && start !== 0xffffffff && start + size === eocd, 'Некорректный каталог или слишком много файлов.');
  let p = start, expanded = 0; const entries = []; const seen = new Set();
  for (let i = 0; i < count; i++) {
    check(p + 46 <= eocd && buf.readUInt32LE(p) === 0x02014b50, 'Повреждён каталог ZIP.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), compressed = buf.readUInt32LE(p + 20), length = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const attrs = buf.readUInt32LE(p + 38), mode = (attrs >>> 16) & 0xf000;
    check(p + 46 + nl + el + cl <= eocd && !(flags & 1) && (method === 0 || method === 8), 'Архив зашифрован или имеет неподдерживаемый формат.');
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    check(name === 'assets/' || safeRelative(name), 'Недопустимый файл архива.');
    check(!seen.has(name.toLowerCase()), 'В архиве повторяются имена файлов.'); seen.add(name.toLowerCase());
    check(mode !== 0xa000 && (mode === 0 || mode === 0x8000 || (mode === 0x4000 && name === 'assets/')), 'Специальные файлы и ссылки не допускаются.');
    check(length <= (name === 'manifest.json' ? LIMITS.json : LIMITS.file) && compressed <= LIMITS.archive, 'Слишком большой файл в архиве.');
    check(local + 30 <= start && buf.readUInt32LE(local) === 0x04034b50, 'Повреждён заголовок файла ZIP.');
    const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28);
    check(local + 30 + ln + le + compressed <= start, 'Данные ZIP выходят за границы архива.');
    check(buf.subarray(local + 30, local + 30 + ln).toString('utf8') === name, 'Имена в заголовках ZIP не совпадают.');
    expanded += length; check(expanded <= LIMITS.expanded, 'Распакованный экзамен больше 512 МБ.');
    if (name !== 'assets/') entries.push({ name, size: length });
    p += 46 + nl + el + cl;
  }
  check(p === eocd && seen.has('manifest.json'), 'В архиве нет manifest.json или повреждён каталог.');
  return entries;
}
async function extractPackage(file, dest) {
  const stat = await fsp.stat(file); check(stat.size <= LIMITS.archive, 'Архив больше 256 МБ.');
  const buffer = await fsp.readFile(file); const entries = preflightZip(buffer);
  const zip = await JSZip.loadAsync(buffer, { createFolders: false });
  await mkdir(dest);
  try {
    for (const item of entries) {
      const entry = zip.file(item.name); check(entry && !entry.dir, 'Повреждён файл в ZIP.');
      const saved = await boundedCopy(entry.nodeStream('nodebuffer'), inside(dest, item.name), item.size);
      check(saved.size === item.size, 'Размер файла ZIP не совпадает с каталогом.');
    }
  } catch (e) { await fsp.rm(dest, { recursive: true, force: true }); throw e; }
  return readJson(path.join(dest, 'manifest.json'));
}
async function writeZip(files, dest) {
  const zip = new JSZip();
  for (const { name, file, data } of files) zip.file(name, file ? fs.createReadStream(file) : data, { createFolders: false, unixPermissions: 0o100600 });
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`; await mkdir(path.dirname(dest));
  try {
    await pipeline(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' }), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    const h = await fsp.open(tmp, 'r+'); try { await h.sync(); } finally { await h.close(); }
    await fsp.rename(tmp, dest); await syncDir(path.dirname(dest));
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
function rasterMime(buffer, ext) {
  const sig = buffer.subarray(0, 16);
  const detected = sig.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : sig[0] === 255 && sig[1] === 216 && sig[2] === 255 ? 'image/jpeg'
    : /GIF8[79]a/.test(sig.subarray(0, 6).toString('ascii')) ? 'image/gif'
    : sig.subarray(0, 4).toString('ascii') === 'RIFF' && sig.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
    : sig.subarray(0, 2).toString('ascii') === 'BM' ? 'image/bmp' : null;
  const expected = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext];
  check(detected && detected === expected, 'Файл не является изображением указанного формата. SVG не поддерживается.');
  return detected;
}
module.exports = { fs, fsp, path, crypto, JSZip, LIMITS, MiB, UserError, check, mkdir, atomic, json, readJson, safeName, safeRelative, inside, hashFile, boundedCopy, preflightZip, extractPackage, writeZip, rasterMime };
