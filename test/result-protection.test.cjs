'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { Readable } = require('node:stream');
const { fsp, path, crypto, LIMITS } = require('../src/io.cjs');
const RP = require('../src/result-protection.cjs');
const { TeacherProtection, SESSION_MS } = require('../src/teacher.cjs');
const PASSWORD = 'Teacher-result-password-2026';
const OTHER_PASSWORD = 'Another-teacher-password-2026';
const MARKER = 'PRIVATE-PUPIL-RESULT-4F04A8';
let pair, other;
before(async () => { [pair, other] = await Promise.all([RP.generateResultKeyPair(), RP.generateResultKeyPair()]); });
async function context(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-result-protection-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}
async function teacher(t, root, name, password = PASSWORD) {
  root ||= await context(t); let clock = 0;
  const options = { monotonic: () => clock }, dir = path.join(root, name || 'teacher');
  const protection = new TeacherProtection(dir, options); await protection.init();
  await protection.configure(password, { title: 'Synthetic protected teacher editor' });
  return { root, dir, protection, options, advance: ms => { clock += ms; } };
}
async function noTemps(root) { assert.equal((await fsp.readdir(root)).some(name => name.endsWith('.tmp')), false); }

test('recipient fingerprints validate exact RSA-3072 SPKI and reject altered or private keys', () => {
  const canonical = RP.validateRecipient({ ...pair.recipient, publicKey: pair.recipient.publicKey.replace(/\n/g, '\r\n'), extra: 'ignored' });
  assert.deepEqual(canonical, pair.recipient);
  for (const value of [null, { ...pair.recipient, version: 2 }, { ...pair.recipient, keyId: '0'.repeat(64) },
    { ...pair.recipient, publicKey: pair.privateKey }, { ...pair.recipient, publicKey: pair.recipient.publicKey + 'junk' }])
    assert.throws(() => RP.validateRecipient(value), e => e.code === 'RESULT_RECIPIENT_INVALID');
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const der = ec.export({ type: 'spki', format: 'der' });
  assert.throws(() => RP.validateRecipient({ format: 'oge-result-recipient', version: 1,
    keyId: crypto.createHash('sha256').update(der).digest('hex'), publicKey: ec.export({ type: 'spki', format: 'pem' }).toString() }), e => e.code === 'RESULT_RECIPIENT_INVALID');
  assert.throws(() => RP.validateKeyPair({ recipient: pair.recipient, privateKey: other.privateKey }), e => e.code === 'RESULT_INVALID');
});

test('streamed result round trip is encrypted, bounded, and publishes authenticated plaintext only', async t => {
  const root = await context(t), plaintext = Buffer.from((MARKER + '\n').repeat(2000));
  const encrypted = path.join(root, 'work.oger'), output = path.join(root, 'opened.zip');
  await RP.encryptStream(Readable.from([plaintext.subarray(0, 71), plaintext.subarray(71)]), encrypted, pair.recipient);
  assert.equal(await RP.isEncryptedResult(encrypted), true);
  const bytes = await fsp.readFile(encrypted); assert.equal(bytes.includes(Buffer.from(MARKER)), false);
  assert.ok(bytes.length < plaintext.length + RP.HEADER_LIMIT + RP.MAGIC.length + 20);
  await RP.decryptFile(encrypted, output, [pair]); assert.deepEqual(await fsp.readFile(output), plaintext);
  assert.equal(await RP.isEncryptedResult(output), false); await noTemps(root);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(encrypted)).mode & 0o777, 0o600);
});

test('file encryption supports in-place replacement and zero-byte files without plaintext staging', async t => {
  const root = await context(t), file = path.join(root, 'source.json'); await fsp.writeFile(file, MARKER);
  await RP.encryptFile(file, file, pair.recipient, { purpose: 'session' });
  assert.equal((await fsp.readFile(file)).includes(Buffer.from(MARKER)), false);
  await RP.decryptFile(file, file, [pair], { purpose: 'session' }); assert.equal(await fsp.readFile(file, 'utf8'), MARKER);
  await fsp.writeFile(file, ''); await RP.encryptFile(file, file, pair.recipient);
  await RP.decryptFile(file, file, [pair]); assert.equal((await fsp.stat(file)).size, 0); await noTemps(root);
});

test('wrong recipient and purpose never publish plaintext or replace the destination', async t => {
  const root = await context(t), file = path.join(root, 'work.oger'), output = path.join(root, 'opened.zip');
  await fsp.writeFile(path.join(root, 'work.zip'), MARKER); await RP.encryptFile(path.join(root, 'work.zip'), file, pair.recipient);
  await fsp.writeFile(output, 'previous-good-work');
  await assert.rejects(RP.decryptFile(file, output, [other]), e => e.code === 'RESULT_KEY_REQUIRED');
  await assert.rejects(RP.decryptFile(file, output, [pair], { purpose: 'session' }), e => e.code === 'RESULT_INVALID');
  assert.equal(await fsp.readFile(output, 'utf8'), 'previous-good-work'); await noTemps(root);
});

test('ciphertext/tag/header tampering and truncation remove unauthenticated temporary files', async t => {
  const root = await context(t), file = path.join(root, 'damaged.oger'), output = path.join(root, 'opened.zip');
  const bytes = RP.encryptBuffer(Buffer.from(MARKER.repeat(4000)), pair.recipient, { purpose: 'results' });
  const tagOffset = RP.MAGIC.length + 4 + bytes.readUInt32BE(RP.MAGIC.length);
  const changedBody = Buffer.from(bytes); changedBody[changedBody.length - 1] ^= 1;
  const changedTag = Buffer.from(bytes); changedTag[tagOffset] ^= 1;
  const hugeHeader = Buffer.from(bytes); hugeHeader.writeUInt32BE(0xffffffff, RP.MAGIC.length);
  const changedPurpose = Buffer.from(bytes.toString('latin1').replace('"purpose":"results"', '"purpose":"session"'), 'latin1');
  const variants = [[changedBody, 'results'], [changedTag, 'results'], [hugeHeader, 'results'],
    [changedPurpose, 'session'], [bytes.subarray(0, bytes.length - 1), 'results'], [bytes.subarray(0, 12), 'results'],
    [Buffer.concat([bytes, Buffer.from([0])]), 'results']];
  for (const [damaged, purpose] of variants) {
    await fsp.writeFile(file, damaged); await fsp.writeFile(output, 'previous-good-work');
    await assert.rejects(RP.decryptFile(file, output, [pair], { purpose }), e => e.code === 'RESULT_INVALID');
    assert.equal(await fsp.readFile(output, 'utf8'), 'previous-good-work'); await noTemps(root);
  }
});

test('stream failures preserve their error and leave neither an export nor temporary ciphertext', async t => {
  const root = await context(t), output = path.join(root, 'failed.oger');
  const source = new Readable({ read() { this.push(Buffer.from(MARKER)); this.destroy(new Error('synthetic input failure')); } });
  await assert.rejects(RP.encryptStream(source, output, pair.recipient), /synthetic input failure/);
  await assert.rejects(fsp.stat(output), e => e.code === 'ENOENT'); await noTemps(root);
});

test('small protected review records authenticate fully in memory and reject buffer tampering', () => {
  const plaintext = Buffer.from(JSON.stringify({ saved: MARKER })), encrypted = RP.encryptBuffer(plaintext, pair.recipient);
  assert.equal(encrypted.includes(Buffer.from(MARKER)), false);
  assert.deepEqual(RP.decryptBuffer(encrypted, [pair]), plaintext);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => RP.decryptBuffer(encrypted, [pair]), e => e.code === 'RESULT_INVALID');
  assert.throws(() => RP.encryptBuffer(plaintext, pair.recipient, { purpose: 'untrusted' }), e => e.code === 'RESULT_INVALID');
  assert.equal(RP.RESULT_LIMIT, LIMITS.archive + RP.MAGIC.length + 4 + RP.HEADER_LIMIT + 16);
});

test('teacher public recipient remains available locked while private key buffers clear on lock and expiry', async t => {
  const c = await teacher(t), { protection: p } = c, recipient = p.resultRecipient(), keys = p.resultPrivateKeys();
  assert.equal(keys.length, 1); assert.ok(Buffer.isBuffer(keys[0].privateKey));
  const sealed = RP.encryptBuffer(Buffer.from(MARKER), recipient);
  for (const name of ['result-keyring.json','result-keyring.json.bak','result-public.json','result-public.json.bak']) {
    const bytes = await fsp.readFile(path.join(c.dir, name));
    assert.equal(bytes.includes(Buffer.from('BEGIN PRIVATE KEY')), false, name); assert.equal(bytes.includes(Buffer.from(PASSWORD)), false, name);
  }
  p.lock(); assert.deepEqual(p.resultRecipient(), recipient); assert.equal(keys[0].privateKey.every(byte => byte === 0), true);
  assert.throws(() => p.resultPrivateKeys(), e => e.status === 403);
  const reopened = new TeacherProtection(c.dir, c.options); await reopened.init();
  assert.deepEqual(reopened.resultRecipient(), recipient); assert.equal(reopened.unlocked(), false);
  await reopened.unlock(PASSWORD); assert.deepEqual(RP.decryptBuffer(sealed, reopened.resultPrivateKeys()), Buffer.from(MARKER));
  const expiryKeys = reopened.resultPrivateKeys(); c.advance(SESSION_MS + 1);
  assert.equal(reopened.unlocked(), false); assert.equal(expiryKeys[0].privateKey.every(byte => byte === 0), true);
});

test('encrypted key backup imports across teacher accounts, retains local recipient and persists old decryption keys', async t => {
  const root = await context(t), source = await teacher(t, root, 'source'), target = await teacher(t, root, 'target', OTHER_PASSWORD);
  const originalRecipient = target.protection.resultRecipient(), sourceRecipient = source.protection.resultRecipient();
  const encrypted = RP.encryptBuffer(Buffer.from(MARKER), sourceRecipient);
  const exported = source.protection.exportResultKeyBackup();
  assert.deepEqual(await target.protection.importResultKeyBackup(exported, PASSWORD), { imported: 1, total: 2 });
  assert.deepEqual(target.protection.resultRecipient(), originalRecipient);
  assert.deepEqual(RP.decryptBuffer(encrypted, target.protection.resultPrivateKeys()), Buffer.from(MARKER));
  assert.deepEqual(await target.protection.importResultKeyBackup(exported, PASSWORD), { imported: 0, total: 2 });
  await target.protection.save({ title: 'Changed teacher editor' }); target.protection.lock();
  const restarted = new TeacherProtection(target.dir, target.options); await restarted.init(); await restarted.unlock(OTHER_PASSWORD);
  assert.deepEqual(restarted.resultRecipient(), originalRecipient); assert.equal(restarted.resultPrivateKeys().length, 2);
  assert.deepEqual(RP.decryptBuffer(encrypted, restarted.resultPrivateKeys()), Buffer.from(MARKER));
  const marker = JSON.parse(await fsp.readFile(path.join(target.dir, 'protection.json'), 'utf8'));
  assert.equal(marker.resultKeysRequired, 1);
});

test('bad backup password and modified backup refuse import without changing any local key', async t => {
  const root = await context(t), source = await teacher(t, root, 'source'), target = await teacher(t, root, 'target', OTHER_PASSWORD);
  const previous = await fsp.readFile(target.protection.resultKeyFile), recipient = target.protection.resultRecipient();
  const backup = source.protection.exportResultKeyBackup();
  await assert.rejects(target.protection.importResultKeyBackup(backup), e => e.status === 400 && e.code === 'RESULT_KEY_PASSWORD_REQUIRED');
  for (const password of ['short', null, 'x'.repeat(129), 'long\0password', 'Wrong-source-password'])
    await assert.rejects(target.protection.importResultKeyBackup(backup, password), e => e.status === 400 && e.code === 'RESULT_KEY_PASSWORD_INVALID');
  assert.equal(target.protection.unlocked(), true, 'a wrong source backup password preserves the local teacher session');
  assert.deepEqual(await fsp.readFile(target.protection.resultKeyFile), previous); assert.equal(target.protection.resultPrivateKeys().length, 1);
  const record = JSON.parse(await fsp.readFile(source.protection.resultKeyFile, 'utf8'));
  record.sealed.tag = (record.sealed.tag[0] === '0' ? '1' : '0') + record.sealed.tag.slice(1);
  const damaged = path.join(root, 'damaged-keyring.json'); await fsp.writeFile(damaged, JSON.stringify(record));
  await assert.rejects(target.protection.importResultKeyBackup(damaged, PASSWORD), e => e.status === 400 && e.code === 'RESULT_KEY_PASSWORD_INVALID');
  assert.deepEqual(target.protection.resultRecipient(), recipient); assert.deepEqual(await fsp.readFile(target.protection.resultKeyFile), previous);
  target.protection.lock(); assert.throws(() => target.protection.exportResultKeyBackup(), e => e.status === 403);
  await assert.rejects(target.protection.importResultKeyBackup(damaged, PASSWORD), e => e.status === 403);
});

test('missing keyring primary recovers encrypted backup; deleting both refuses silent recipient rotation', async t => {
  const c = await teacher(t), recipient = c.protection.resultRecipient(); c.protection.lock();
  await fsp.rm(c.protection.resultKeyFile);
  const recovered = new TeacherProtection(c.dir, c.options); await recovered.init(); await recovered.unlock(PASSWORD);
  assert.deepEqual(recovered.resultRecipient(), recipient); recovered.lock();
  await fsp.rm(c.protection.resultKeyFile); await fsp.rm(`${c.protection.resultKeyFile}.bak`);
  await assert.rejects(new TeacherProtection(c.dir, c.options).init(), e => e.status === 500);
  assert.deepEqual(JSON.parse(await fsp.readFile(c.protection.resultPublicFile, 'utf8')), recipient);
});

test('missing recipient and corrupt records fail closed on an installation that already has result keys', async t => {
  const c = await teacher(t); c.protection.lock();
  const publicBytes = await fsp.readFile(c.protection.resultPublicFile), ringBytes = await fsp.readFile(c.protection.resultKeyFile);
  await fsp.rm(c.protection.resultPublicFile); await fsp.rm(`${c.protection.resultPublicFile}.bak`);
  await assert.rejects(new TeacherProtection(c.dir, c.options).init(), e => e.status === 500);
  await fsp.writeFile(c.protection.resultPublicFile, publicBytes); await fsp.writeFile(`${c.protection.resultPublicFile}.bak`, publicBytes);
  const record = JSON.parse(ringBytes); record.sealed.tag = '0'.repeat(32);
  await fsp.writeFile(c.protection.resultKeyFile, JSON.stringify(record));
  const damaged = new TeacherProtection(c.dir, c.options); await damaged.init();
  await assert.rejects(damaged.unlock(PASSWORD), e => e.status === 500); assert.equal(damaged.unlocked(), false);
  await fsp.writeFile(c.protection.resultKeyFile, '{');
  await assert.rejects(new TeacherProtection(c.dir, c.options).init(), e => e.status === 500);
});

test('interrupted first publication resumes the same persisted private result key', async t => {
  const root = await context(t), dir = path.join(root, 'teacher'), options = { monotonic: () => 0 };
  const p = new TeacherProtection(dir, options); await p.init();
  const rename = fsp.rename;
  fsp.rename = async (from, to) => { if (to === p.resultPublicFile) throw new Error('synthetic recipient publication failure'); return rename(from, to); };
  try { await assert.rejects(p.configure(PASSWORD, { title: 'Synthetic editor' }), /synthetic recipient publication failure/); }
  finally { fsp.rename = rename; }
  assert.equal(p.configured(), true); assert.equal(p.unlocked(), false);
  const originalRing = await fsp.readFile(p.resultKeyFile);
  const restored = new TeacherProtection(dir, options); await restored.init(); await restored.unlock(PASSWORD);
  assert.deepEqual(await fsp.readFile(p.resultKeyFile), originalRing);
  assert.equal(restored.resultPrivateKeys()[0].recipient.keyId, restored.resultRecipient().keyId); await noTemps(dir);
});
