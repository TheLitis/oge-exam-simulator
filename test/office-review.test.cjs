'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fsp, path, JSZip, hashFile, crypto } = require('../src/io.cjs');
const { ExamService } = require('../src/service.cjs');
const { ods, odp } = require('./helpers/office-fixtures.cjs');
const table = { type: 'spreadsheet', criteria: [{ kind: 'cellValue', sheet: 'Лист1', cell: 'A1', mode: 'number', expected: '5' },
  { kind: 'cellFormula', sheet: 'Лист1', cell: 'A1', expected: '=SUM(B1:C1)' }, { kind: 'sheetCount', expected: 1 }] };
const deck = { type: 'presentation', criteria: [{ kind: 'slideCount', expected: 2 },
  { kind: 'slideText', slide: 1, expected: '<script>alert(1)</script>', comparison: 'exact' }] };
const PERSON = { registration: '00000992', surname: 'Тестовый', name: 'Ученик', passportSeries: '0000', passportNumber: '000000' };
async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-office-review-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const s = new ExamService(root); await s.init(); await s.importExam(path.join(__dirname, '../examples/demo.oge'), true);
  await s.setEditorChecker({ taskId: 13, checker: table }); await s.setEditorChecker({ taskId: 14, checker: deck });
  await s.setEditorChecker({ taskId: 15, checker: table });
  const tableFile = path.join(root, 'answer.ods'), deckFile = path.join(root, 'answer.odp');
  await fsp.writeFile(tableFile, await ods('<table:table table:name="Лист1"><table:table-row><table:table-cell office:value-type="float" office:value="5" table:formula="of:=SUM([.B1:.C1])"/></table:table-row></table:table>'));
  await fsp.writeFile(deckFile, await odp('<draw:page><draw:frame><draw:text-box><text:p>&lt;script&gt;alert(1)&lt;/script&gt;</text:p></draw:text-box></draw:frame></draw:page>'));
  return { s, root, tableFile, deckFile };
}

test('Office keys survive teacher project/restart, but never enter published exam or pupil API', async t => {
  const { s, root } = await setup(t);
  const project = await s.exportExam(false), published = await s.exportExam(true);
  const manifest = async item => JSON.parse(await (await JSZip.loadAsync(await fsp.readFile(s.exportFile(item.id)))).file('manifest.json').async('string'));
  assert.equal((await manifest(project)).tasks[12].checker.criteria.length, 3);
  assert.equal((await manifest(published)).tasks.some(task => Object.hasOwn(task, 'checker')), false);
  const restored = new ExamService(root); await restored.init();
  assert.equal(restored.state({teacherAccess:true}).editor.tasks[13].checker.type, 'presentation');
  await s.importExam(s.exportFile(published.id)); await s.start(PERSON, 'DEMO-2026');
  assert.equal(s.state().editor, null); assert.equal(JSON.stringify(s.state().exam).includes('criteria'), false);
  assert.equal(Object.hasOwn(s.task(13), 'checker'), false);
  await assert.rejects(s.setEditorChecker({ taskId: 13, checker: table }));
  await s.finish();
});

test('Office result review grades saved documents per criterion, reports safely and preserves original ZIP', async t => {
  const { s, tableFile, deckFile } = await setup(t);
  const published = await s.exportExam(true); await s.importExam(s.exportFile(published.id)); await s.start(PERSON, 'DEMO-2026');
  for (const [id, file, name] of [[13, tableFile, 'answer.bin'], [14, deckFile, 'answer.odp'], [15, deckFile, 'wrong-family.ods'],
    [16, tableFile, 'manual.ods']]) { await s.attachFile(id, file, name); await s.saveAnswer(id); }
  await s.saveDraft(1, 'Несданный черновик'); await s.finish();
  const source = s.attempt.archivePath, before = await hashFile(source), review = await s.importReview(source);
  const result = await s.checkReview({ id: review.id });
  assert.deepEqual(result.tasks.slice(12).map(task => task.status), ['correct', 'incorrect', 'error', 'manual']);
  assert.equal(result.tasks[12].format, 'ods'); assert.equal(result.tasks[12].criteria.length, 3);
  assert.deepEqual(result.tasks[13].criteria.map(item => item.status), ['incorrect', 'correct']);
  assert.match(result.tasks[14].message, /другого типа/); assert.equal(result.summary.unanswered, 12);
  const report = await JSZip.loadAsync(await fsp.readFile(await s.reviewReport(review.id)));
  const html = await report.file('assessment.html').async('string'), csv = await report.file('assessment.csv').async('string');
  assert.match(html, /Число слайдов: Неверно/); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false); assert.match(csv, /Число слайдов/);
  const sums = JSON.parse(await report.file('SHA256.json').async('string'));
  for (const [name, digest] of Object.entries(sums)) assert.equal(crypto.createHash('sha256').update(await report.file(name).async('nodebuffer')).digest('hex'), digest);
  assert.equal(crypto.createHash('sha256').update(await report.file('original-results.zip').async('nodebuffer')).digest('hex'), before);
  assert.equal(await hashFile(source), before);
});

test('unsupported Office data fails clearly without execution and later checks continue', async t => {
  const { s, root, tableFile } = await setup(t), invalid = path.join(root, 'invalid.pptx');
  await fsp.writeFile(invalid, 'Not an Office document');
  const published = await s.exportExam(true); await s.importExam(s.exportFile(published.id)); await s.start(PERSON, 'DEMO-2026');
  await s.attachFile(14, invalid, 'answer.pptx'); await s.saveAnswer(14);
  await s.attachFile(15, tableFile, 'answer.ods'); await s.saveAnswer(15); await s.finish();
  let calls = 0; s.codeRunner.runCode = () => { calls++; throw new Error('Unexpected code execution'); };
  const review = await s.importReview(s.attempt.archivePath), result = await s.checkReview({ id: review.id });
  assert.equal(result.tasks[13].status, 'error'); assert.match(result.tasks[13].message, /ODS|XLSX|ODP|PPTX/);
  assert.equal(result.tasks[14].status, 'correct'); assert.equal(calls, 0);
});
