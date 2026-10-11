'use strict';
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { fs, fsp, path, crypto, JSZip, LIMITS, UserError, json, mkdir, preflightZip } = require('./io.cjs');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 15 * 60 * 1000;
const KDF = Object.freeze({ algorithm: 'scrypt', N: 32768, r: 8, p: 1 });
const MAX_PLAINTEXT = 3 * LIMITS.json;
const MAX_RECORD = 4 * Math.ceil(MAX_PLAINTEXT / 3) + 2048;
const PROJECT_MAGIC = Buffer.from('OGE-PRIVATE-V1\n', 'ascii');
const PROJECT_TAG_OFFSET = PROJECT_MAGIC.length + 16 + 12;
const PROJECT_OVERHEAD = PROJECT_TAG_OFFSET + 16;
const PROJECT_LIMIT = LIMITS.archive + PROJECT_OVERHEAD;
const corrupt = () => new UserError('Хранилище учителя повреждено. Сохраните папку данных и обратитесь к организатору.', 500);

// The public editor cache has a deliberate allowlist. The activation hash and
// every checker (including code test inputs) remain only in the encrypted vault.
function publicEditor(editor) {
  if (!editor) return null;
  const asset = a => ({ id: a.id, name: a.name, path: a.path, mime: a.mime, size: a.size, sha256: a.sha256 });
  return { format: editor.format, version: editor.version, id: editor.id, title: editor.title,
    durationSeconds: editor.durationSeconds, published: false, activation: null,
    teacherProtected: true, teacherHasActivation: !!(editor.activation || editor.teacherHasActivation),
    tasks: editor.tasks.map(t => ({ id: t.id, images: t.images.map(asset), resources: t.resources.map(asset) })) };
}
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128 || password.includes('\0'))
    throw new UserError('Пароль учителя должен содержать от 10 до 128 символов.');
}
function projectError(code) {
  const e = new UserError(code === 'PROJECT_PASSWORD_REQUIRED' ? 'Введите пароль учителя, которым защищён этот проект.' : 'Неверный пароль проекта или повреждённый проект.');
  e.code = code; return e;
}
async function isProtectedProject(file) {
  const h = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(PROJECT_MAGIC.length); const { bytesRead } = await h.read(b, 0, b.length, 0); return bytesRead === b.length && b.equals(PROJECT_MAGIC); }
  finally { await h.close(); }
}
// This compatibility path is used ONLY for app-owned exports during migration.
// Ordinary uploads still use io.extractPackage's unchanged strict preflight.
async function readLegacyPackage(file) {
  const h = await fsp.open(file, 'r'); let source;
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > LIMITS.archive + 65535)
      throw new UserError('Прежний внутренний архив не распознан.');
    const bounded = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await h.read(bounded, length, bounded.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new UserError('Прежний внутренний архив изменился.');
    source = bounded.subarray(0, length);
  } finally { await h.close(); }
  let end = -1;
  for (let i = source.length - 22; i >= Math.max(0, source.length - 65557); i--) {
    if (source.readUInt32LE(i) === 0x06054b50 && i + 22 + source.readUInt16LE(i + 20) === source.length) { end = i; break; }
  }
  if (end < 0) throw new UserError('Прежний внутренний архив не распознан.');
  const buffer = Buffer.from(source.subarray(0, end + 22)); buffer.writeUInt16LE(0, end + 20);
  // Canonicalize only the final comment, then apply every current archive check
  // before invoking JSZip. No asset is inflated merely to classify an export.
  const entries = preflightZip(buffer), item = entries.find(e => e.name === 'manifest.json');
  let manifest;
  try {
    const zip = await JSZip.loadAsync(buffer, { createFolders: false }), entry = zip.file('manifest.json');
    if (!entry || entry.dir) throw new Error('Missing manifest');
    const chunks = []; let length = 0;
    for await (const chunk of entry.nodeStream('nodebuffer')) {
      length += chunk.length;
      if (length > item.size || length > LIMITS.json) throw new Error('Invalid manifest size');
      chunks.push(chunk);
    }
    if (length !== item.size) throw new Error('Invalid manifest size');
    manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new UserError('Прежний внутренний архив не распознан.'); }
  return { buffer, manifest };
}
function validateRecord(record) {
  const k = record?.kdf, s = record?.sealed;
  if (record?.format !== 'oge-teacher-vault' || record.version !== 1 || k?.algorithm !== KDF.algorithm ||
      k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p || !/^[0-9a-f]{32}$/.test(k.salt ?? '') ||
      !/^[0-9a-f]{24}$/.test(s?.iv ?? '') || !/^[0-9a-f]{32}$/.test(s?.tag ?? '') ||
      typeof s?.ciphertext !== 'string' || !s.ciphertext.length || s.ciphertext.length > MAX_RECORD ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.ciphertext)) throw corrupt();
  const bytes = Buffer.from(s.ciphertext, 'base64');
  if (bytes.length > MAX_PLAINTEXT || bytes.toString('base64') !== s.ciphertext) throw corrupt();
  return record;
}
async function readRecord(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD) throw corrupt();
  let record;
  try { record = validateRecord(JSON.parse(await fsp.readFile(file, 'utf8'))); }
  catch { throw corrupt(); }
  await fsp.chmod(file, 0o600);
  return record;
}
function aad(salt) { return Buffer.from(`oge-teacher-vault:1:scrypt:${KDF.N}:${KDF.r}:${KDF.p}:${salt}`); }
function seal(editor, key, salt, legacyBackup) {
  const plaintext = Buffer.from(JSON.stringify({ format: 'oge-teacher-editor', version: 1, editor,
    ...(legacyBackup === undefined ? {} : { legacyBackup }) }));
  if (plaintext.length > MAX_PLAINTEXT) { plaintext.fill(0); throw new UserError('Проект учителя слишком большой.'); }
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(salt));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { format: 'oge-teacher-vault', version: 1, kdf: { ...KDF, salt },
      sealed: { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') } };
  } finally { plaintext.fill(0); }
}
function open(record, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.sealed.iv, 'hex'));
  decipher.setAAD(aad(record.kdf.salt)); decipher.setAuthTag(Buffer.from(record.sealed.tag, 'hex'));
  let first, last, plaintext;
  try {
    first = decipher.update(Buffer.from(record.sealed.ciphertext, 'base64')); last = decipher.final();
    plaintext = Buffer.concat([first, last]);
    const value = JSON.parse(plaintext.toString('utf8'));
    if (value?.format !== 'oge-teacher-editor' || value.version !== 1 || !value.editor) throw corrupt();
    return value.editor;
  } finally { first?.fill(0); last?.fill(0); plaintext?.fill(0); }
}

class TeacherProtection {
  constructor(dir, { monotonic, onLock = () => {} }) {
    this.dir = dir; this.file = path.join(dir, 'protection.json'); this.monotonic = monotonic; this.onLock = onLock;
    this.record = null; this.key = null; this.token = null; this.expiresAt = 0;
    this.nextUnlockAt = 0; this.badPasswords = 0; this.busy = false;
  }
  configured() { return !!this.record; }
  async init({ required = false } = {}) {
    await mkdir(this.dir);
    const dir = await fsp.lstat(this.dir); if (!dir.isDirectory() || dir.isSymbolicLink()) throw corrupt();
    await fsp.chmod(this.dir, 0o700);
    try { this.record = await readRecord(this.file); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // A missing primary must never turn a configured installation back into
      // first-time setup. Only the encrypted backup can recover the record.
      try { this.record = await readRecord(`${this.file}.bak`); await json(this.file, this.record); }
      catch (backupError) { if (backupError.code !== 'ENOENT' || required) throw corrupt(); }
    }
    if (this.record) {
      try { await readRecord(`${this.file}.bak`); }
      catch (e) { if (e.code === 'ENOENT') await json(`${this.file}.bak`, this.record); else throw e; }
    }
    this.lock();
  }
  lock() {
    this.key?.fill(0); this.token?.fill(0); this.key = null; this.token = null; this.expiresAt = 0;
    if (this.configured()) this.onLock();
  }
  unlocked() {
    if (this.key && this.monotonic() >= this.expiresAt) this.lock();
    return !!this.key;
  }
  authorized(token) {
    if (!this.unlocked() || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const actual = Buffer.from(token, 'hex');
    try { return crypto.timingSafeEqual(this.token, actual); } finally { actual.fill(0); }
  }
  assertUnlocked() {
    if (!this.unlocked()) throw new UserError('Режим учителя закрыт. Введите пароль учителя.', 403);
  }
  issueSession(key) {
    this.lock(); this.key = key; this.token = crypto.randomBytes(32); this.expiresAt = this.monotonic() + SESSION_MS;
    return { token: this.token.toString('hex') };
  }
  async configure(password, editor, { backupEditor = editor, legacyBackup } = {}) {
    if (this.configured()) throw new UserError('Пароль учителя уже настроен.', 409);
    validPassword(password);
    if (this.busy) throw new UserError('Настройка учителя уже выполняется.', 409);
    this.busy = true; let key;
    try {
      const salt = crypto.randomBytes(16).toString('hex');
      key = await scrypt(password, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
      const record = seal(editor, key, salt, legacyBackup), backup = seal(backupEditor, key, salt, legacyBackup);
      await json(this.file, record); this.record = record;
      await json(`${this.file}.bak`, backup);
      const result = this.issueSession(key); key = null; return result;
    } catch (e) { if (this.configured()) this.lock(); throw e; }
    finally { key?.fill(0); this.busy = false; }
  }
  async unlock(password) {
    if (!this.configured()) throw new UserError('Сначала настройте пароль учителя.', 409);
    validPassword(password);
    const remaining = this.nextUnlockAt - this.monotonic();
    if (this.busy || remaining > 0) {
      const e = new UserError('Подождите перед следующей попыткой ввода пароля учителя.', 429);
      e.retryAfter = Math.max(1, Math.ceil(remaining / 1000)); throw e;
    }
    this.busy = true; this.nextUnlockAt = this.monotonic() + 1000; let key;
    try {
      key = await scrypt(password, this.record.kdf.salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
      let editor;
      try { editor = open(this.record, key); }
      catch (e) {
        this.badPasswords++; this.nextUnlockAt = this.monotonic() + Math.min(30000, 1000 * this.badPasswords);
        if (e instanceof UserError) throw e;
        throw new UserError('Неверный пароль учителя или повреждённое хранилище.', 403);
      }
      const result = this.issueSession(key); key = null; this.badPasswords = 0; this.nextUnlockAt = 0;
      return { ...result, editor };
    } finally { key?.fill(0); this.busy = false; }
  }
  async save(editor) {
    this.assertUnlocked();
    const record = seal(editor, this.key, this.record.kdf.salt);
    await json(this.file, record, true); this.record = record;
    await fsp.chmod(`${this.file}.bak`, 0o600);
  }
  async protectProject(file, out = file, { allowLegacySize = false } = {}) {
    this.assertUnlocked();
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (!allowLegacySize && stat.size > LIMITS.archive)) throw new UserError('Проект больше 256 МБ или недоступен.');
    const salt = Buffer.from(this.record.kdf.salt, 'hex'), iv = crypto.randomBytes(12);
    const prefix = Buffer.concat([PROJECT_MAGIC, salt, iv]), header = Buffer.concat([prefix, Buffer.alloc(16)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(prefix);
    const temp = `${out}.${crypto.randomUUID()}.tmp`; let h;
    await mkdir(path.dirname(out));
    try {
      h = await fsp.open(temp, 'wx', 0o600); await h.write(header, 0, header.length, 0);
      await pipeline(fs.createReadStream(file), cipher, fs.createWriteStream(temp, { fd: h.fd, start: header.length, autoClose: false }));
      const tag = cipher.getAuthTag(); await h.write(tag, 0, tag.length, PROJECT_TAG_OFFSET);
      await h.sync(); await h.close(); h = null; await fsp.rename(temp, out);
      await fsp.chmod(out, 0o600);
    } finally { await h?.close(); await fsp.rm(temp, { force: true }).catch(() => {}); }
  }
  async openProject(file, out, password) {
    if (this.configured()) this.assertUnlocked();
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= PROJECT_OVERHEAD || stat.size > PROJECT_LIMIT) throw projectError('PROJECT_PASSWORD_INVALID');
    const h = await fsp.open(file, 'r'); const header = Buffer.alloc(PROJECT_OVERHEAD);
    try { const { bytesRead } = await h.read(header, 0, header.length, 0); if (bytesRead !== header.length) throw projectError('PROJECT_PASSWORD_INVALID'); }
    finally { await h.close(); }
    if (!header.subarray(0, PROJECT_MAGIC.length).equals(PROJECT_MAGIC)) throw projectError('PROJECT_PASSWORD_INVALID');
    const salt = header.subarray(PROJECT_MAGIC.length, PROJECT_MAGIC.length + 16).toString('hex');
    const iv = header.subarray(PROJECT_MAGIC.length + 16, PROJECT_TAG_OFFSET); let key;
    if (this.unlocked() && salt === this.record.kdf.salt) key = Buffer.from(this.key);
    else {
      if (password === undefined) throw projectError('PROJECT_PASSWORD_REQUIRED');
      if (typeof password !== 'string' || !password.length || password.length > 128 || password.includes('\0')) throw projectError('PROJECT_PASSWORD_INVALID');
      key = await scrypt(password, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header.subarray(0, PROJECT_TAG_OFFSET)); decipher.setAuthTag(header.subarray(PROJECT_TAG_OFFSET));
    let written = false;
    try {
      await mkdir(path.dirname(out));
      // Unauthenticated bytes are written only to a private temporary file.
      // The caller parses the ZIP only after pipeline verifies the GCM tag.
      await pipeline(fs.createReadStream(file, { start: PROJECT_OVERHEAD }), decipher, fs.createWriteStream(out, { flags: 'wx', mode: 0o600 }));
      written = true;
    } catch (e) {
      if (!e.code || e.code.startsWith('ERR_OSSL_') || ['ERR_CRYPTO_INVALID_AUTH_TAG','ERR_CRYPTO_AUTH_FAILED'].includes(e.code))
        throw projectError('PROJECT_PASSWORD_INVALID');
      throw e;
    }
    finally { key.fill(0); if (!written) await fsp.rm(out, { force: true }).catch(() => {}); }
  }
}
module.exports = { TeacherProtection, publicEditor, SESSION_MS, PROJECT_LIMIT, PROJECT_OVERHEAD, isProtectedProject, readLegacyPackage };
