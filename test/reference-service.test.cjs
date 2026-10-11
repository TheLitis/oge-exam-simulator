'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fsp, path, JSZip } = require('../src/io.cjs');
const { ExamService } = require('../src/service.cjs');
const { writeReviewReport } = require('../src/review.cjs');
const DEMO = path.join(__dirname, '../examples/demo.oge');
const PASSWORD = 'Synthetic reference teacher password';
const SOURCE = '# SYNTHETIC-PRIVATE-REFERENCE\nprint(42)\n';

async function editor(t, runCode) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-reference-service-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const codeRunner = { capabilities: async () => ({ available: true, languages: { python: true, javascript: true } }), runCode };
  const s = new ExamService(root, { codeRunner }); await s.init(); await s.configureTeacher(PASSWORD);
  await s.importExam(DEMO, true); return { s, root, codeRunner };
}

test('reference solution and optional task-16 condition file survive protected restart but never pupil export', async t => {
  const calls = [];
  const { s, root, codeRunner } = await editor(t, async request => {
    calls.push(request);
    assert.equal(request.language, 'python'); assert.equal(request.input, '20\n22\n');
    assert.equal(request.source.toString(), SOURCE); assert.equal(Object.hasOwn(request, 'expected'), false);
    assert.equal(request.resources[0].name, 'numbers.txt');
    assert.equal(await fsp.readFile(request.resources[0].file, 'utf8'), '20\n22\n');
    return { status: 'ok', stdout: '42\n', durationMs: 1 };
  });
  const condition = path.join(root, 'synthetic-numbers.txt'); await fsp.writeFile(condition, '20\n22\n');
  await s.addEditorAsset(condition, 'numbers.txt', 16, 'resource');
  await s.setEditorChecker({ taskId: 16, checker: { type: 'code', language: 'javascript',
    reference: { language: 'python', source: SOURCE }, tests: [{ input: '20\n22\n' }, { input: '', expected: '' }] } });
  const view = s.state({ teacherAccess: true }).editor.tasks[15];
  assert.equal(view.hasResources, true); assert.equal(view.requiresResources, false);
  const preview = await s.previewReference({ taskId: 16 });
  assert.equal(preview.status, 'ok'); assert.equal(calls.length, 1);
  assert.equal(preview.tests[0].expected, '42\n'); assert.equal(preview.tests[1].expected, '');
  assert.equal(JSON.stringify(preview).includes(SOURCE), false);
  const published = await s.exportExam(true), archive = await JSZip.loadAsync(await fsp.readFile(await s.exportFile(published.id)));
  const manifest = JSON.parse(await archive.file('manifest.json').async('string'));
  assert.equal(manifest.tasks.some(task => Object.hasOwn(task, 'checker')), false);
  assert.equal(manifest.tasks[15].resources[0].name, 'numbers.txt');
  assert.equal(JSON.stringify(manifest).includes('SYNTHETIC-PRIVATE-REFERENCE'), false);
  assert.equal((await fsp.readFile(s.dir('editor/manifest.json'), 'utf8')).includes('SYNTHETIC-PRIVATE-REFERENCE'), false);
  await s.lockTeacher(); await assert.rejects(s.previewReference({ taskId: 16 }), error => error.status === 403);
  const restored = new ExamService(root, { codeRunner }); await restored.init();
  assert.equal(JSON.stringify(restored.state()).includes('SYNTHETIC-PRIVATE-REFERENCE'), false);
  await restored.unlockTeacher(PASSWORD);
  assert.equal(restored.editor.tasks[15].checker.reference.source, SOURCE);
  assert.equal(restored.state({ teacherAccess: true }).editor.tasks[14].requiresResources, false);
  assert.equal((await restored.exportExam(true)).published, true);
});

test('teacher report preserves multiline comparisons and escapes their HTML', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-reference-report-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'original-results.zip'), 'synthetic original');
  const record = { originalSha256: '0'.repeat(64), registration: '000123', surname: 'Тестовый', name: 'Ученик', title: 'Синтетический вариант', contextMatch: true };
  const assessment = { tasks: [{ id: 16, status: 'incorrect', message: 'Пройдено тестов: 0 из 1.', tests: [
    { index: 1, status: 'incorrect', input: '<script>\n20\n22', expected: '42\n', actual: '41\n', message: 'Вывод отличается.' }
  ] }], summary: { correct: 0, incorrect: 1 } };
  await writeReviewReport(record, assessment, root);
  const html = await fsp.readFile(path.join(root, 'assessment.html'), 'utf8');
  assert.match(html, /Вход:/); assert.match(html, /Ожидалось:/); assert.match(html, /Получено:/);
  assert.match(html, /&lt;script&gt;/); assert.equal(html.includes('<script>'), false);
  const csv = await fsp.readFile(path.join(root, 'assessment.csv'), 'utf8');
  assert.match(csv, /Вход:\n<script>\n20\n22/); assert.match(csv, /Ожидалось:\n42\n/);
  const json = JSON.parse(await fsp.readFile(path.join(root, 'assessment.json'), 'utf8'));
  assert.equal(json.assessment.tasks[0].tests[0].input, '<script>\n20\n22');
});
