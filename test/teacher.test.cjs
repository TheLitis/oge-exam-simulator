'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fsp, path, crypto, JSZip, hashFile, preflightZip } = require('../src/io.cjs');
const { ExamService } = require('../src/service.cjs');
const { SESSION_MS, PROJECT_OVERHEAD, isProtectedProject } = require('../src/teacher.cjs');
const { ods } = require('./helpers/office-fixtures.cjs');
const DEMO = path.join(__dirname, '../examples/demo.oge');
const PASSWORD = 'Teacher-test-password-2026';
const MARKER = 'REFERENCE-ONLY-TEACHER-73D147F2';
const CHECKER = { type: 'short', answers: [MARKER], caseSensitive: true, ignoreWhitespace: false };
const PERSON = { registration: '00000831', surname: 'Тестовый', name: 'Ученик', passportSeries: '0000', passportNumber: '000000' };

async function context(t, { project = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-teacher-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let clock = 0;
  const options = { monotonic: () => clock, now: () => Date.now() + clock,
    codeRunner: { capabilities: async () => ({ available: false, languages: {} }), runCode: async () => { throw new Error('No code execution in teacher tests'); } } };
  const s = new ExamService(root, options); await s.init();
  if (project) { await s.importExam(DEMO, true); await s.setEditorChecker({ taskId: 1, checker: CHECKER }); }
  return { root, s, options, advance: ms => { clock += ms; } };
}
const noChecker = value => !JSON.stringify(value).includes('checker');
async function assertPrivateCache(root) {
  for (const name of ['editor/manifest.json', 'editor/manifest.json.bak', 'teacher/protection.json', 'teacher/protection.json.bak', 'config.json', 'config.json.bak']) {
    let data;
    try { data = await fsp.readFile(path.join(root, name)); }
    catch (e) { if (name === 'config.json.bak' && e.code === 'ENOENT') continue; throw e; }
    assert.equal(data.includes(Buffer.from(MARKER)), false, name);
    assert.equal(data.includes(Buffer.from(PASSWORD)), false, name);
  }
  for (const name of ['editor/manifest.json', 'editor/manifest.json.bak']) {
    const value = JSON.parse(await fsp.readFile(path.join(root, name), 'utf8'));
    assert.equal(noChecker(value), true); assert.equal(value.activation, null); assert.equal(value.teacherProtected, true);
  }
}

test('teacher setup encrypts current editor and backup; default state and restart are locked', async t => {
  const { root, s, options } = await context(t);
  assert.equal(noChecker(s.state()), true);
  assert.deepEqual(s.state({ teacherAccess: true }).editor.tasks[0].checker, CHECKER);
  const activationHash = s.editor.activation.hash, { token } = await s.configureTeacher(PASSWORD);
  assert.equal(s.teacherConfigured(), true); assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(s.teacherAuthorized(token), true); assert.equal(s.teacherAuthorized('f'.repeat(64)), false);
  assert.equal(s.teacherAuthorized(token.slice(1)), false); assert.equal(noChecker(s.state()), true);
  assert.deepEqual(s.state({ teacherAccess: s.teacherAuthorized(token) }).editor.tasks[0].checker, CHECKER);
  await assertPrivateCache(root);
  for (const name of ['editor/manifest.json', 'editor/manifest.json.bak'])
    assert.equal((await fsp.readFile(path.join(root, name))).includes(Buffer.from(activationHash)), false);
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(s.dir('teacher'))).mode & 0o777, 0o700);
    for (const name of ['teacher/protection.json', 'teacher/protection.json.bak', 'editor/manifest.json', 'editor/manifest.json.bak'])
      assert.equal((await fsp.stat(s.dir(name))).mode & 0o777, 0o600);
  }
  await s.lockTeacher(); assert.equal(s.teacherAuthorized(token), false); assert.equal(noChecker(s.editor), true);
  await assert.rejects(s.setEditorChecker({ taskId: 1, checker: CHECKER }), e => e.status === 403);
  const restored = new ExamService(root, options); await restored.init();
  assert.deepEqual(restored.state().teacher, { configured: true, unlocked: false });
  assert.equal(noChecker(restored.state({ teacherAccess: true })), true);
  const unlocked = await restored.unlockTeacher(PASSWORD); assert.notEqual(unlocked.token, token);
  assert.deepEqual(restored.state({ teacherAccess: restored.teacherAuthorized(unlocked.token) }).editor.tasks[0].checker, CHECKER);
});

test('teacher password bounds, no reset, throttled unlock, and fifteen minute expiry preserve the editor', async t => {
  const { s, root, advance } = await context(t);
  await assert.rejects(s.unlockTeacher(PASSWORD), e => e.status === 409);
  for (const password of ['123456789', 'x'.repeat(129), 'long\0password'])
    await assert.rejects(s.configureTeacher(password), e => e.status === 400);
  const { token } = await s.configureTeacher(PASSWORD);
  await assert.rejects(s.configureTeacher('another-teacher-password'), e => e.status === 409);
  const before = await hashFile(s.dir('teacher/protection.json'));
  await assert.rejects(s.unlockTeacher('Wrong-password-2026'), e => e.status === 403);
  assert.equal(s.teacherAuthorized(token), true, 'a failed unlock does not close another valid teacher session');
  await assert.rejects(s.unlockTeacher(PASSWORD), e => e.status === 429 && e.retryAfter > 0);
  advance(1001); const next = await s.unlockTeacher(PASSWORD);
  assert.equal(s.teacherAuthorized(token), false); assert.equal(s.teacherAuthorized(next.token), true);
  advance(SESSION_MS + 1);
  assert.equal(s.teacherAuthorized(next.token), false); assert.equal(noChecker(s.editor), true);
  assert.equal(noChecker(s.state({ teacherAccess: true })), true);
  assert.equal(await hashFile(s.dir('teacher/protection.json')), before);
  await assertPrivateCache(root);
  await s.unlockTeacher(PASSWORD); assert.deepEqual(s.editor.tasks[0].checker, CHECKER);
});

test('corrupt or deleted protection records fail closed and cannot reopen first-time setup', async t => {
  const { s, root, options } = await context(t); await s.configureTeacher(PASSWORD); await s.lockTeacher();
  const primary = await fsp.readFile(s.dir('teacher/protection.json'));
  const backup = await fsp.readFile(s.dir('teacher/protection.json.bak'));
  await fsp.writeFile(s.dir('teacher/protection.json'), '{');
  await assert.rejects(new ExamService(root, options).init(), e => e.status === 500);
  assert.equal(noChecker(JSON.parse(await fsp.readFile(s.dir('editor/manifest.json'), 'utf8'))), true);
  await fsp.writeFile(s.dir('teacher/protection.json'), primary);
  await fsp.rm(s.dir('teacher/protection.json')); await fsp.rm(s.dir('teacher/protection.json.bak'));
  await assert.rejects(new ExamService(root, options).init(), e => e.status === 500);
  await fsp.writeFile(s.dir('teacher/protection.json.bak'), backup);
  const recovered = new ExamService(root, options); await recovered.init();
  assert.equal(recovered.teacherConfigured(), true); assert.equal(recovered.state().teacher.unlocked, false);
  await assert.rejects(recovered.configureTeacher('replacement-password'), e => e.status === 409);
});

test('interrupted setup stays configured and locked; the original password resumes the internal file migration', async t => {
  const { s, root } = await context(t), exported = await s.exportExam(false), file = s.exportFile(exported.id);
  const migrate = s.protectStoredTeacherFiles.bind(s);
  s.protectStoredTeacherFiles = async () => { throw new Error('Benign simulated migration failure'); };
  await assert.rejects(s.configureTeacher(PASSWORD), /simulated migration failure/);
  assert.equal(s.teacherConfigured(), true); assert.equal(s.state().teacher.unlocked, false);
  assert.equal(noChecker(s.editor), true); assert.notEqual(s.config.teacherFilesProtected, 1);
  await assertPrivateCache(root);
  await assert.rejects(s.configureTeacher('replacement-password'), e => e.status === 409);
  s.protectStoredTeacherFiles = migrate;
  await s.unlockTeacher(PASSWORD);
  assert.deepEqual(s.editor.tasks[0].checker, CHECKER); assert.equal(await isProtectedProject(file), true);
  assert.equal(s.config.teacherFilesProtected, 1);
});

test('setup migrates internal private exports and old import caches; published packets remain byte-identical', async t => {
  const { s, root } = await context(t);
  const project = await s.exportExam(false), published = await s.exportExam(true);
  const projectFile = s.exportFile(project.id), publishedFile = s.exportFile(published.id), publicHash = await hashFile(publishedFile);
  const external = path.join(root, 'outside-internal-exports.oge'); await fsp.copyFile(projectFile, external);
  const externalHash = await hashFile(external);
  const legacy = s.dir('exams', crypto.randomUUID()); await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(s.editor));
  await s.configureTeacher(PASSWORD);
  assert.equal(await isProtectedProject(projectFile), true);
  assert.equal(await isProtectedProject(path.join(legacy, 'manifest.json')), true);
  assert.equal(await hashFile(publishedFile), publicHash); assert.equal(await hashFile(external), externalHash);
  await assert.rejects(JSZip.loadAsync(await fsp.readFile(projectFile)));
  const fresh = await s.exportExam(false), freshFile = s.exportFile(fresh.id);
  assert.equal(await isProtectedProject(freshFile), true);
  const raw = await fsp.readFile(freshFile); assert.equal(raw.includes(Buffer.from(MARKER)), false);
  await s.importExam(freshFile, true); assert.deepEqual(s.editor.tasks[0].checker, CHECKER);
  assert.deepEqual(await fsp.readdir(s.dir('teacher/runtime')), []);
  await assertPrivateCache(root);
});

test('private edit imports stage only under teacher runtime and stale crash workspaces disappear on restart', async t => {
  const { s, root, options } = await context(t); await s.configureTeacher(PASSWORD);
  const exported = await s.exportExam(false), file = s.exportFile(exported.id);
  const exams = await fsp.readdir(s.dir('exams')), persist = s.persistEditor.bind(s); let staged = false;
  s.persistEditor = async next => {
    const workspaces = (await fsp.readdir(s.dir('teacher/runtime'))).filter(name => /^workspace-[a-f0-9-]{36}$/.test(name));
    assert.equal(workspaces.length, 1);
    const manifest = await fsp.readFile(s.dir('teacher/runtime', workspaces[0], 'manifest.json'), 'utf8');
    assert.equal(manifest.includes(MARKER), true); assert.deepEqual(await fsp.readdir(s.dir('exams')), exams);
    staged = true; await persist(next);
  };
  await s.importExam(file, true); s.persistEditor = persist;
  assert.equal(staged, true); assert.deepEqual(await fsp.readdir(s.dir('exams')), exams);
  assert.deepEqual(await fsp.readdir(s.dir('teacher/runtime')), []);
  const stale = s.dir('teacher/runtime', `workspace-${crypto.randomUUID()}`); await fsp.mkdir(stale);
  await fsp.writeFile(path.join(stale, 'manifest.json'), JSON.stringify({ synthetic: MARKER }));
  const restarted = new ExamService(root, options); await restarted.init();
  await assert.rejects(fsp.stat(stale), e => e.code === 'ENOENT');
  assert.deepEqual(await fsp.readdir(restarted.dir('teacher/runtime')), []); assert.equal(noChecker(restarted.state()), true);
  await restarted.unlockTeacher(PASSWORD); assert.deepEqual(restarted.editor.tasks[0].checker, CHECKER);
});

test('migration handles ordinary legacy ZIP comments only inside app exports and preserves published original bytes', async t => {
  const { s, root } = await context(t), project = await s.exportExam(false), published = await s.exportExam(true);
  const privateFile = s.exportFile(project.id), publicFile = s.exportFile(published.id);
  for (const file of [privateFile, publicFile]) {
    const zip = await JSZip.loadAsync(await fsp.readFile(file));
    await fsp.writeFile(file, await zip.generateAsync({ type:'nodebuffer', comment:'An ordinary historical archive note' }));
  }
  const publicHash = await hashFile(publicFile), external = path.join(root, 'external-commented-project.oge');
  await fsp.copyFile(privateFile, external); const externalHash = await hashFile(external);
  await assert.rejects(s.importExam(external, true), /Комментарии ZIP/);
  await s.configureTeacher(PASSWORD);
  assert.equal(await isProtectedProject(privateFile), true); assert.equal(await hashFile(publicFile), publicHash);
  assert.equal(await hashFile(external), externalHash);
  const decrypted = path.join(root, 'canonical-private.zip'); await s.teacher.openProject(privateFile, decrypted);
  const canonical = await fsp.readFile(decrypted); assert.doesNotThrow(() => preflightZip(canonical));
  await fsp.rm(decrypted); await s.importExam(privateFile, true);
  assert.deepEqual(s.editor.tasks[0].checker, CHECKER); assert.deepEqual(await fsp.readdir(s.dir('teacher/runtime')), []);
  await assert.rejects(s.importExam(external, true), /Комментарии ZIP/);
});

test('unrecognized internal legacy export bytes are preserved encrypted and do not block setup or unlock', async t => {
  const { s, root } = await context(t), file = s.dir('exports', `${crypto.randomUUID()}.oge`);
  const original = Buffer.from(`An unrecognized historical export\n${MARKER}`); await fsp.writeFile(file, original);
  const { token } = await s.configureTeacher(PASSWORD); assert.equal(s.teacherAuthorized(token), true);
  assert.equal(await isProtectedProject(file), true); assert.equal((await fsp.readFile(file)).includes(Buffer.from(MARKER)), false);
  const recovered = path.join(root, 'recovered-legacy-bytes'); await s.teacher.openProject(file, recovered);
  assert.deepEqual(await fsp.readFile(recovered), original); await fsp.rm(recovered);
  await s.lockTeacher(); const again = await s.unlockTeacher(PASSWORD); assert.equal(s.teacherAuthorized(again.token), true);
  assert.deepEqual(s.editor.tasks[0].checker, CHECKER);
});

test('encrypted portable project requires its source password on another installation and rejects changed ciphertext', async t => {
  const source = await context(t), target = await context(t, { project: false });
  await source.s.configureTeacher(PASSWORD); await target.s.configureTeacher('Other-installation-password');
  const exported = await source.s.exportExam(false), file = source.s.exportFile(exported.id);
  await assert.rejects(target.s.importExam(file, true), e => e.status === 400 && e.code === 'PROJECT_PASSWORD_REQUIRED');
  await assert.rejects(target.s.importExam(file, true, 'Wrong-source-password'), e => e.status === 400 && e.code === 'PROJECT_PASSWORD_INVALID');
  await target.s.importExam(file, true, PASSWORD); assert.deepEqual(target.s.editor.tasks[0].checker, CHECKER);
  const damaged = path.join(source.root, 'damaged-project.oge'), bytes = await fsp.readFile(file);
  bytes[PROJECT_OVERHEAD + 3] ^= 1; await fsp.writeFile(damaged, bytes);
  await assert.rejects(target.s.importExam(damaged, true, PASSWORD), e => e.status === 400 && e.code === 'PROJECT_PASSWORD_INVALID');
  assert.deepEqual(await fsp.readdir(target.s.dir('teacher/runtime')), []);
  assert.deepEqual(target.s.editor.tasks[0].checker, CHECKER, 'a failed edit import preserves the unlocked editor');
});

test('published import and start auto-lock; pupil state, result ZIP and all lifecycle states contain no reference', async t => {
  const { s, root, options } = await context(t); await s.configureTeacher(PASSWORD);
  const published = await s.exportExam(true), file = s.exportFile(published.id);
  const manifest = JSON.parse(await (await JSZip.loadAsync(await fsp.readFile(file))).file('manifest.json').async('string'));
  assert.equal(noChecker(manifest), true);
  const before = await s.unlockTeacher(PASSWORD); await s.importExam(file);
  assert.equal(s.teacherAuthorized(before.token), false); assert.equal(noChecker(s.editor), true); assert.equal(noChecker(s.state()), true);
  const again = await s.unlockTeacher(PASSWORD); await s.start(PERSON, 'DEMO-2026');
  assert.equal(s.teacherAuthorized(again.token), false); assert.equal(s.state().editor, null); assert.equal(noChecker(s.task(1)), true);
  for (const action of [() => s.configureTeacher(PASSWORD), () => s.unlockTeacher(PASSWORD), () => s.updateEditor({ title: 'Closed' }), () => s.importReview(DEMO)])
    await assert.rejects(action());
  await s.saveAnswer(1, 'Student answer'); await s.finish();
  const results = await JSZip.loadAsync(await fsp.readFile(s.attempt.archivePath));
  for (const item of Object.values(results.files).filter(item => !item.dir))
    assert.equal((await item.async('nodebuffer')).includes(Buffer.from(MARKER)), false, item.name);
  assert.equal(noChecker(s.state()), true); await s.dismissResult(); assert.equal(noChecker(s.state()), true);
  const restored = new ExamService(root, options); await restored.init(); assert.equal(noChecker(restored.state()), true);
  await restored.unlockTeacher(PASSWORD); assert.deepEqual(restored.editor.tasks[0].checker, CHECKER);
});

async function reviewed(t, { configured = false } = {}) {
  const c = await context(t), { s, root } = c;
  await s.setEditorChecker({ taskId: 13, checker: { type: 'spreadsheet', criteria: [
    { kind: 'cellValue', sheet: 'Лист1', cell: 'A1', mode: 'text', expected: MARKER } ] } });
  if (configured) await s.configureTeacher(PASSWORD);
  const published = await s.exportExam(true), file = s.exportFile(published.id); await s.importExam(file); await s.start(PERSON, 'DEMO-2026');
  const answer = path.join(root, 'pupil.ods');
  await fsp.writeFile(answer, await ods('<table:table table:name="Лист1"><table:table-row><table:table-cell office:value-type="string"><text:p>Student answer</text:p></table:table-cell></table:table-row></table:table>'));
  await s.attachFile(13, answer, 'answer.ods'); await s.saveAnswer(13); await s.finish();
  if (configured) await s.unlockTeacher(PASSWORD);
  const review = await s.importReview(s.attempt.archivePath); const assessment = await s.checkReview({ id: review.id });
  assert.equal(assessment.tasks[12].criteria[0].expected, MARKER);
  return { ...c, review };
}
test('setup migrates old review criteria and reports; future assessments are encrypted and download temps disappear on cleanup, lock, expiry or restart', async t => {
  const { s, root, review, advance, options } = await reviewed(t);
  assert.equal((await fsp.readFile(s.dir('reviews', review.id, 'assessment.json'))).includes(Buffer.from(MARKER)), true);
  await s.configureTeacher(PASSWORD);
  const names = ['assessment.json', 'assessment.html', 'assessment.csv', 'SHA256.json', 'reviewed-results.zip'];
  for (const name of names) assert.equal(await isProtectedProject(s.dir('reviews', review.id, name)), true, name);
  const opened = await s.reviewReport(review.id), zip = await JSZip.loadAsync(await fsp.readFile(opened.file));
  assert.equal((await zip.file('assessment.json').async('string')).includes(MARKER), true);
  await opened.cleanup(); await assert.rejects(fsp.stat(opened.file), e => e.code === 'ENOENT');
  await s.checkReview({ id: review.id });
  for (const name of names) {
    assert.equal(await isProtectedProject(s.dir('reviews', review.id, name)), true, name);
    assert.equal((await fsp.readFile(s.dir('reviews', review.id, name))).includes(Buffer.from(MARKER)), false, name);
  }
  const closing = await s.reviewReport(review.id); await s.lockTeacher();
  await assert.rejects(fsp.stat(closing.file), e => e.code === 'ENOENT');
  await assert.rejects(s.reviewReport(review.id), e => e.status === 403);
  await s.unlockTeacher(PASSWORD); const expiring = await s.reviewReport(review.id);
  advance(SESSION_MS + 1); await s.pulse();
  await assert.rejects(fsp.stat(expiring.file), e => e.code === 'ENOENT');
  assert.equal(noChecker(s.editor), true);
  await s.unlockTeacher(PASSWORD); const stale = await s.reviewReport(review.id);
  const restarted = new ExamService(root, options); await restarted.init();
  await assert.rejects(fsp.stat(stale.file), e => e.code === 'ENOENT');
  assert.equal(restarted.state().teacher.unlocked, false);
  assert.deepEqual(await fsp.readdir(path.join(root, 'teacher/runtime')), []);
});
