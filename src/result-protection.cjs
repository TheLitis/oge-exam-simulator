'use strict';
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { fs, fsp, path, crypto, LIMITS, UserError, mkdir } = require('./io.cjs');

const generateKeyPair = promisify(crypto.generateKeyPair);
const MAGIC = Buffer.from('OGE-RESULT-V1\n', 'ascii');
const HEADER_LIMIT = 2048;
const TAG_BYTES = 16;
const RSA_BYTES = 384;
const RESULT_LIMIT = LIMITS.archive + MAGIC.length + 4 + HEADER_LIMIT + TAG_BYTES;
const PURPOSES = new Set(['results', 'session', 'review']);
const ALGORITHM = 'RSA-OAEP-256+A256GCM';
const invalid = () => Object.assign(new UserError('Зашифрованная работа повреждена или не может быть открыта этим ключом.'), { code: 'RESULT_INVALID' });
const badRecipient = () => Object.assign(new UserError('Ключ получателя результатов не распознан.'), { code: 'RESULT_RECIPIENT_INVALID' });
function purposeValue(purpose) {
  if (!PURPOSES.has(purpose)) throw invalid();
  return purpose;
}
function publicDescriptor(key) {
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072 || key.asymmetricKeyDetails?.publicExponent !== 65537n)
    throw badRecipient();
  const der = key.export({ format: 'der', type: 'spki' });
  return { format: 'oge-result-recipient', version: 1,
    keyId: crypto.createHash('sha256').update(der).digest('hex'), publicKey: key.export({ format: 'pem', type: 'spki' }).toString() };
}
function validateRecipient(value) {
  if (value?.format !== 'oge-result-recipient' || value.version !== 1 || !/^[0-9a-f]{64}$/.test(value.keyId ?? '') ||
      typeof value.publicKey !== 'string' || Buffer.byteLength(value.publicKey) > 4096 || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(value.publicKey))
    throw badRecipient();
  try {
    const canonical = publicDescriptor(crypto.createPublicKey(value.publicKey));
    if (canonical.keyId !== value.keyId || canonical.publicKey.trim() !== value.publicKey.replace(/\r\n/g, '\n').trim()) throw badRecipient();
    return canonical;
  } catch { throw badRecipient(); }
}
async function generateResultKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair('rsa', { modulusLength: 3072, publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { recipient: publicDescriptor(crypto.createPublicKey(publicKey)), privateKey };
}
function validateKeyPair(value) {
  const recipient = validateRecipient(value?.recipient);
  if ((!Buffer.isBuffer(value?.privateKey) && typeof value?.privateKey !== 'string') || Buffer.byteLength(value.privateKey) > 16384) throw invalid();
  try {
    const key = crypto.createPrivateKey(value.privateKey);
    if (publicDescriptor(crypto.createPublicKey(key)).keyId !== recipient.keyId) throw invalid();
    return { recipient, privateKey: key };
  } catch { throw invalid(); }
}
function newCipher(recipient, purpose) {
  recipient = validateRecipient(recipient); purpose = purposeValue(purpose);
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  try {
    const wrapped = crypto.publicEncrypt({ key: recipient.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    const header = Buffer.from(JSON.stringify({ format: 'oge-encrypted-result', version: 1, algorithm: ALGORITHM,
      purpose, keyId: recipient.keyId, iv: iv.toString('hex'), wrappedKey: wrapped.toString('base64') }));
    if (header.length > HEADER_LIMIT) throw invalid();
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, size, header]), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    return { cipher, aad, tagOffset: aad.length, prefix: Buffer.concat([aad, Buffer.alloc(TAG_BYTES)]) };
  } finally { key.fill(0); }
}
function parseHeader(prefix, totalSize, purpose) {
  purposeValue(purpose);
  if (totalSize < MAGIC.length + 4 + TAG_BYTES || totalSize > RESULT_LIMIT || prefix.length < MAGIC.length + 4 || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid();
  const size = prefix.readUInt32BE(MAGIC.length), tagOffset = MAGIC.length + 4 + size, offset = tagOffset + TAG_BYTES;
  if (!size || size > HEADER_LIMIT || prefix.length < offset || offset > totalSize || totalSize - offset > LIMITS.archive) throw invalid();
  let header;
  try { header = JSON.parse(prefix.subarray(MAGIC.length + 4, tagOffset).toString('utf8')); } catch { throw invalid(); }
  const expectedFields = ['format','version','algorithm','purpose','keyId','iv','wrappedKey'];
  if (!header || typeof header !== 'object' || Object.keys(header).length !== expectedFields.length || expectedFields.some(name => !Object.hasOwn(header, name)) ||
      header.format !== 'oge-encrypted-result' || header.version !== 1 || header.algorithm !== ALGORITHM || header.purpose !== purpose ||
      !/^[0-9a-f]{64}$/.test(header.keyId ?? '') || !/^[0-9a-f]{24}$/.test(header.iv ?? '') ||
      typeof header.wrappedKey !== 'string' || header.wrappedKey.length !== RSA_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]+$/.test(header.wrappedKey)) throw invalid();
  const wrapped = Buffer.from(header.wrappedKey, 'base64');
  if (wrapped.length !== RSA_BYTES || wrapped.toString('base64') !== header.wrappedKey) throw invalid();
  return { header, aad: prefix.subarray(0, tagOffset), tag: prefix.subarray(tagOffset, offset), wrapped, offset };
}
function newDecipher(parsed, privateKeys) {
  if (!Array.isArray(privateKeys) || privateKeys.length > 32) throw invalid();
  const pair = privateKeys.find(value => value?.recipient?.keyId === parsed.header.keyId);
  if (!pair) throw Object.assign(new UserError('Для этой работы нужен ключ учителя, которому она предназначена. Импортируйте его резервную копию.'), { code: 'RESULT_KEY_REQUIRED' });
  const checked = validateKeyPair(pair); let key;
  try {
    key = crypto.privateDecrypt({ key: checked.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, parsed.wrapped);
    if (key.length !== 32) throw invalid();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.header.iv, 'hex'));
    decipher.setAAD(parsed.aad); decipher.setAuthTag(parsed.tag); return decipher;
  } catch { throw invalid(); }
  finally { key?.fill(0); }
}
function sizeCounter(limit, expected) {
  let size = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > limit) return callback(new UserError('Архив результатов больше 256 МБ.', 413));
    callback(null, chunk);
  }, flush(callback) {
    callback(expected !== undefined && size !== expected ? invalid() : null);
  } });
}
async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const h = await fsp.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); }
}
async function encryptSource(readable, outPath, recipient, { purpose = 'results' } = {}, expectedSize, beforePublish = async () => {}) {
  const { cipher, prefix, tagOffset } = newCipher(recipient, purpose), temp = `${outPath}.${crypto.randomUUID()}.tmp`;
  let h;
  await mkdir(path.dirname(outPath));
  try {
    h = await fsp.open(temp, 'wx', 0o600); await h.write(prefix, 0, prefix.length, 0);
    await pipeline(readable, sizeCounter(LIMITS.archive, expectedSize), cipher, fs.createWriteStream(temp, { fd: h.fd, start: prefix.length, autoClose: false }));
    const tag = cipher.getAuthTag(); await h.write(tag, 0, tag.length, tagOffset);
    await h.sync(); await h.close(); h = null; await beforePublish(); await fsp.rename(temp, outPath); await syncDirectory(path.dirname(outPath));
    return outPath;
  } finally { await h?.close().catch(() => {}); await fsp.rm(temp, { force: true }).catch(() => {}); }
}
async function encryptStream(readable, outPath, recipient, options) { return encryptSource(readable, outPath, recipient, options); }
async function openRegular(file, maximum) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw invalid();
  const h = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await h.stat();
    if (!stat.isFile() || stat.size > maximum || stat.dev !== before.dev || stat.ino !== before.ino) throw invalid();
    return { h, stat };
  } catch (e) { await h.close(); throw e; }
}
async function encryptFile(inputPath, outPath, recipient, options) {
  const { h, stat } = await openRegular(inputPath, LIMITS.archive);
  try {
    const stream = fs.createReadStream(inputPath, { fd: h.fd, autoClose: false });
    // The bounded stream must end at the same size inspected on its open handle.
    await encryptSource(stream, outPath, recipient, options, stat.size, () => h.close());
    return outPath;
  } finally { await h.close().catch(() => {}); }
}
async function decryptFile(inputPath, outPath, privateKeys, { purpose = 'results' } = {}) {
  const { h, stat } = await openRegular(inputPath, RESULT_LIMIT), temp = `${outPath}.${crypto.randomUUID()}.tmp`;
  let writer;
  try {
    const prefix = Buffer.alloc(Math.min(stat.size, MAGIC.length + 4 + HEADER_LIMIT + TAG_BYTES));
    let bytesRead = 0;
    while (bytesRead < prefix.length) {
      const next = await h.read(prefix, bytesRead, prefix.length - bytesRead, bytesRead);
      if (!next.bytesRead) break; bytesRead += next.bytesRead;
    }
    const parsed = parseHeader(prefix.subarray(0, bytesRead), stat.size, purpose), decipher = newDecipher(parsed, privateKeys);
    await mkdir(path.dirname(outPath));
    writer = await fsp.open(temp, 'wx', 0o600);
    try {
      await pipeline(fs.createReadStream(inputPath, { fd: h.fd, autoClose: false, start: parsed.offset }),
        sizeCounter(LIMITS.archive, stat.size - parsed.offset), decipher, fs.createWriteStream(temp, { fd: writer.fd, autoClose: false }));
    } catch (e) {
      if (!e.code || e.code.startsWith('ERR_OSSL_') || e.code.startsWith('ERR_CRYPTO_')) throw invalid();
      throw e;
    }
    // The destination becomes visible only after pipeline has authenticated GCM.
    await writer.sync(); await writer.close(); writer = null; await h.close();
    await fsp.rename(temp, outPath); await syncDirectory(path.dirname(outPath)); return outPath;
  } finally { await writer?.close().catch(() => {}); await h.close().catch(() => {}); await fsp.rm(temp, { force: true }).catch(() => {}); }
}
async function isEncryptedResult(file) {
  const { h } = await openRegular(file, RESULT_LIMIT);
  try { const b = Buffer.alloc(MAGIC.length); const { bytesRead } = await h.read(b, 0, b.length, 0); return bytesRead === b.length && b.equals(MAGIC); }
  finally { await h.close(); }
}
function encryptBuffer(plaintext, recipient, { purpose = 'review' } = {}) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > LIMITS.archive) throw invalid();
  const { cipher, aad } = newCipher(recipient, purpose), body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([aad, cipher.getAuthTag(), body]);
}
function decryptBuffer(encrypted, privateKeys, { purpose = 'review' } = {}) {
  if (!Buffer.isBuffer(encrypted)) throw invalid();
  const parsed = parseHeader(encrypted, encrypted.length, purpose), decipher = newDecipher(parsed, privateKeys);
  let first, last;
  try { first = decipher.update(encrypted.subarray(parsed.offset)); last = decipher.final(); return Buffer.concat([first, last]); }
  catch { throw invalid(); }
  finally { first?.fill(0); last?.fill(0); }
}
module.exports = { validateRecipient, generateResultKeyPair, validateKeyPair, encryptFile, encryptStream, decryptFile,
  isEncryptedResult, encryptBuffer, decryptBuffer, RESULT_LIMIT, HEADER_LIMIT, MAGIC };
