'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { migrateLegacyResults } = require('../src/results.cjs');

const STEM = 'OGE_2026-10-10_00004567_05745dbd';
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-results-migration-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'hidden', 'results'), target = path.join(root, 'Документы', 'Результаты экзаменов');
  await fsp.mkdir(path.join(source, STEM, 'files', 'task-13'), { recursive: true });
  await fsp.writeFile(path.join(source, STEM, 'report.html'), '<html>Сохранено 16/16</html>');
  await fsp.writeFile(path.join(source, STEM, 'answers.json'), '{"savedCount":16}');
  await fsp.writeFile(path.join(source, STEM, 'files', 'task-13', 'Ответ.tmp'), Buffer.from([0, 255, 10, 128, 13]));
  await fsp.writeFile(path.join(source, `${STEM}.zip`), crypto.randomBytes(160 * 1024 + 19));
  return { root, source, target };
}
async function hash(file) { return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex'); }
async function assertPair(source, target, stem = STEM) {
  for (const file of ['report.html', 'answers.json', 'files/task-13/Ответ.tmp']) {
    assert.equal(await hash(path.join(target, stem, file)), await hash(path.join(source, STEM, file)));
  }
  assert.equal(await hash(path.join(target, `${stem}.zip`)), await hash(path.join(source, `${STEM}.zip`)));
}

test('legacy result pair is copied byte-for-byte, including ZIP, without hidden or temporary exports', async t => {
  const { root, source, target } = await fixture(t);
  await fsp.writeFile(path.join(source, STEM, '.unrelated-secret'), 'skip');
  await fsp.writeFile(path.join(source, '.hidden'), 'skip');
  await fsp.writeFile(path.join(source, 'notes.txt'), 'skip');
  await fsp.mkdir(path.join(source, `${STEM}.tmp`));
  await fsp.writeFile(path.join(source, `${STEM}.zip.tmp`), 'unfinished');
  const outside = path.join(root, 'outside.txt'); await fsp.writeFile(outside, 'do not follow');
  let links = false;
  try {
    await fsp.symlink(outside, path.join(source, STEM, 'linked-file'));
    await fsp.symlink(outside, path.join(source, 'OGE_linked.zip'));
    links = true;
  } catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error; }
  const originalZip = await hash(path.join(source, `${STEM}.zip`));
  const moved = await migrateLegacyResults(source, target);
  assert.deepEqual([...moved], [
    [path.join(source, STEM), path.join(target, STEM)],
    [path.join(source, `${STEM}.zip`), path.join(target, `${STEM}.zip`)]
  ]);
  await assertPair(source, target);
  assert.equal(await hash(path.join(source, `${STEM}.zip`)), originalZip);
  assert.deepEqual((await fsp.readdir(target)).sort(), [STEM, `${STEM}.zip`]);
  await assert.rejects(fsp.access(path.join(target, STEM, '.unrelated-secret')), { code: 'ENOENT' });
  if (links) await assert.rejects(fsp.access(path.join(target, STEM, 'linked-file')), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(path.join(target, STEM))).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(target, `${STEM}.zip`))).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(path.join(target, STEM, 'report.html'))).mode & 0o777, 0o600);
  }
});

test('repeated migration reuses identical results without replacing existing files', async t => {
  const { source, target } = await fixture(t);
  const first = await migrateLegacyResults(source, target);
  const archive = path.join(target, `${STEM}.zip`), before = await fsp.stat(archive);
  const second = await migrateLegacyResults(source, target), after = await fsp.stat(archive);
  assert.deepEqual([...second], [...first]);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual((await fsp.readdir(target)).sort(), [STEM, `${STEM}.zip`]);
  await assertPair(source, target);
});

test('conflicting pair is preserved and the copied folder and ZIP share a stable content suffix', async t => {
  const { source, target } = await fixture(t);
  await fsp.mkdir(path.join(target, STEM), { recursive: true });
  await fsp.writeFile(path.join(target, STEM, 'report.html'), 'existing result');
  await fsp.writeFile(path.join(target, `${STEM}.zip`), 'existing ZIP');
  const before = await hash(path.join(target, `${STEM}.zip`));
  const first = await migrateLegacyResults(source, target);
  const directory = first.get(path.join(source, STEM)), archive = first.get(path.join(source, `${STEM}.zip`));
  assert.match(path.basename(directory), new RegExp(`^${STEM}_[a-f0-9]{16}$`));
  assert.equal(archive, `${directory}.zip`);
  assert.equal(await hash(path.join(target, `${STEM}.zip`)), before);
  assert.equal(await fsp.readFile(path.join(target, STEM, 'report.html'), 'utf8'), 'existing result');
  await assertPair(source, target, path.basename(directory));
  const second = await migrateLegacyResults(source, target);
  assert.deepEqual([...second], [...first]);
  assert.equal((await fsp.readdir(target)).length, 4);
});

test('interrupted migration completes the same partial pair and propagates destination errors', async t => {
  const { root, source, target } = await fixture(t);
  await fsp.mkdir(path.join(target, STEM), { recursive: true });
  const report = path.join(target, STEM, 'report.html');
  await fsp.copyFile(path.join(source, STEM, 'report.html'), report);
  const before = await fsp.stat(report);
  await fsp.mkdir(path.join(target, '.oge-results-migration-interrupted'));
  await fsp.writeFile(path.join(target, '.oge-results-migration-interrupted', 'partial'), 'not published');
  const moved = await migrateLegacyResults(source, target);
  assert.equal(moved.get(path.join(source, STEM)), path.join(target, STEM));
  assert.equal((await fsp.stat(report)).ino, before.ino);
  await assertPair(source, target);
  assert.equal((await fsp.readdir(target)).filter(name => name.startsWith('OGE_')).length, 2);
  const blocked = path.join(root, 'blocked'); await fsp.writeFile(blocked, 'ordinary file');
  await assert.rejects(migrateLegacyResults(source, path.join(blocked, 'results')), { code: 'ENOTDIR' });
  await assertPair(source, target);
});

test('absent legacy results are a no-op and do not create the destination', async t => {
  const { root } = await fixture(t);
  const missing = path.join(root, 'missing', 'results'), target = path.join(root, 'unused');
  assert.deepEqual([...await migrateLegacyResults(missing, target)], []);
  await assert.rejects(fsp.access(target), { code: 'ENOENT' });
});
