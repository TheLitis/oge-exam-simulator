'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fsp, path, crypto } = require('../src/io.cjs');
const { LIMITS, validateChecker, assessExam, normalize } = require('../src/grading.cjs');

function short(answers = ['42'], extra = {}) { return { type: 'short', answers, ...extra }; }
function code(tests = [{ input: '', expected: '42' }], extra = {}) { return { type: 'code', language: 'python', tests, ...extra }; }
function input(id, checker, answer, extra = {}) {
  return { exam: { tasks: [{ id, checker, images: [], resources: [] }] }, attempt: { answers: answer ? { [id]: answer } : {},
    drafts: {}, draftFiles: {} }, ...extra };
}
async function fixture(t, data = '42\n') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-grading-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'blobs'));
  const id = crypto.randomUUID(), relative = `blobs/${id}`, file = path.join(root, relative);
  await fsp.writeFile(file, data);
  const buffer = Buffer.from(data);
  return { root, file, answer: { kind: 'file', file: { id, path: relative, name: 'answer.txt', size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex') } } };
}
const row = result => result.tasks[0];

test('optional checkers retain compatibility and produce canonical comparison defaults', () => {
  assert.equal(validateChecker(1, undefined), null);
  assert.equal(validateChecker(16, null), null);
  assert.deepEqual(validateChecker(1, short()), { type: 'short', answers: ['42'], caseSensitive: true, ignoreWhitespace: false });
  assert.deepEqual(validateChecker(13, { type: 'text', expected: '' }), { type: 'text', expected: '', comparison: 'trim', caseSensitive: true });
  assert.deepEqual(validateChecker(16, code()), { ...code(), comparison: 'trim' });
});

test('checker validation rejects wrong task kinds, arbitrary execution settings and oversized tests', () => {
  for (const [id, checker] of [[13, short()], [1, code()], [12, { type: 'text', expected: '42' }],
    [1, short([''])], [1, short([' \t '], { ignoreWhitespace: true })], [1, short(['42'], { caseSensitive: 'false' })],
    [1, short(['42'], { ignoreWhitespace: 'false' })], [1, short(['4\0'])], [1, short(['\ud800'])],
    [1, short(['42'], { command: 'rm -rf /' })],
    [13, { type: 'code', language: 'shell', tests: [{ input: '', expected: '42' }] }],
    [13, code([], {})], [13, code(Array.from({ length: LIMITS.tests + 1 }, () => ({ input: '', expected: '42' })))],
    [13, code([{ input: 'я'.repeat(LIMITS.testBytes), expected: '' }])], [13, code([{ input: '', expected: '', path: '/etc/passwd' }])],
    [13, { type: 'text', expected: '42', comparison: 'number' }], [13, code([{ input: '', expected: '42' }], { timeout: 100000 })]]) {
    assert.throws(() => validateChecker(id, checker), { name: 'UserError' });
  }
  assert.throws(() => validateChecker(0, null), { name: 'UserError' });
  assert.throws(() => validateChecker(1, short(Array(LIMITS.answers + 1).fill('42'))), { name: 'UserError' });
  assert.throws(() => validateChecker(13, code(Array(16).fill({ input: 'a'.repeat(16000), expected: '42' }))), { name: 'UserError' });
});

test('short answers compare complete strings with explicit whitespace and case rules', async () => {
  for (const [text, checker, expected] of [
    [' 42\r\n', short(), 'correct'], ['042', short(), 'incorrect'], ['42 ответ', short(), 'incorrect'],
    ['4 2', short(), 'incorrect'], ['4 \n2', short(['42'], { ignoreWhitespace: true }), 'correct'],
    ['вЕРНО', short(['Верно']), 'incorrect'], ['вЕРНО', short(['Верно'], { caseSensitive: false }), 'correct'],
    ['43', short(['42', '43']), 'correct'], ['٤٢', short(), 'incorrect'],
    ['A\nB', short(['A\r\nB']), 'correct'], ['е', short(['e']), 'incorrect'],
  ]) {
    const result = await assessExam(input(1, checker, { kind: 'short', text }));
    assert.equal(row(result).status, expected, `${JSON.stringify(text)} vs ${JSON.stringify(checker)}`);
    assert.equal(result.summary.configured, 1);
    assert.equal(result.summary[expected], 1);
    assert.equal('expected' in row(result), false);
  }
  assert.equal(normalize(' 42\n', { comparison: 'exact' }), ' 42\n');
});

test('only saved answers count; missing answers and draft files never enter the runner', async () => {
  let calls = 0;
  const result = await assessExam({ exam: { tasks: [{ id: 1 }, { id: 2, checker: short() }, { id: 13, checker: code() }] },
    attempt: { answers: { 1: { kind: 'short', text: '42' } }, drafts: { 2: '42' }, draftFiles: { 13: { path: 'do-not-run' } } },
    runCode: () => { calls++; } });
  assert.deepEqual(result.tasks.map(task => task.status), ['manual', 'unanswered', 'unanswered']);
  assert.deepEqual(result.summary, { total: 3, configured: 2, correct: 0, incorrect: 0, unanswered: 2, manual: 1, error: 0, unavailable: 0 });
  assert.equal(calls, 0);
  assert.equal(row(await assessExam(input(1, short(), { kind: 'short', text: '  ' }))).status, 'unanswered');
});

test('text file comparison is UTF-8, whole content, configurable case and trim', async t => {
  const { root, answer } = await fixture(t, ' Верно\r\n');
  for (const [checker, expected] of [[{ type: 'text', expected: 'Верно' }, 'correct'],
    [{ type: 'text', expected: 'верно' }, 'incorrect'], [{ type: 'text', expected: 'верно', caseSensitive: false }, 'correct'],
    [{ type: 'text', expected: 'Верно', comparison: 'exact' }, 'incorrect'],
    [{ type: 'text', expected: ' Верно\n', comparison: 'exact' }, 'correct']]) {
    assert.equal(row(await assessExam(input(13, checker, answer, { attemptDir: root }))).status, expected);
  }
  const empty = await fixture(t, '');
  assert.equal(row(await assessExam(input(13, { type: 'text', expected: '' }, empty.answer, { attemptDir: empty.root }))).status, 'correct');
});

test('invalid UTF-8 and binary submissions report a checking error', async t => {
  for (const data of [Buffer.from([0xff, 0xfe, 0x34, 0]), Buffer.from('42\0')]) {
    const { root, answer } = await fixture(t, data);
    const result = await assessExam(input(13, { type: 'text', expected: '42' }, answer, { attemptDir: root }));
    assert.equal(row(result).status, 'error');
    assert.equal(result.summary.incorrect, 0);
  }
});

test('file hashes and sizes are checked before content comparison or execution', async t => {
  const { root, answer } = await fixture(t, 'print(42)');
  let calls = 0;
  for (const file of [{ ...answer.file, sha256: '0'.repeat(64) }, { ...answer.file, size: answer.file.size + 1 },
    { ...answer.file, sha256: undefined }]) {
    const result = await assessExam(input(13, code(), { kind: 'file', file }, { attemptDir: root,
      runCode: () => { calls++; return { status: 'ok', stdout: '42' }; } }));
    assert.equal(row(result).status, 'error');
  }
  assert.equal(calls, 0);
  const withoutHash = structuredClone(answer); delete withoutHash.file.sha256;
  assert.equal(row(await assessExam(input(13, { type: 'text', expected: 'print(42)' }, withoutHash, { attemptDir: root }))).status, 'correct');
});

test('path traversal, absolute files, missing blobs and symlinks cannot become checked answers', async t => {
  const { root, file, answer } = await fixture(t);
  for (const relative of ['../outside', '/etc/passwd', 'blobs\\answer', 'blobs/../../outside', `blobs/${crypto.randomUUID()}`]) {
    const tampered = structuredClone(answer); tampered.file.path = relative;
    assert.equal(row(await assessExam(input(13, { type: 'text', expected: '42' }, tampered, { attemptDir: root }))).status, 'error');
  }
  const target = path.join(root, 'outside.txt'); await fsp.writeFile(target, '42\n'); await fsp.unlink(file);
  try { await fsp.symlink(target, file); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.diagnostic('Symlink test unavailable for this account.'); throw error; }
  assert.equal(row(await assessExam(input(13, { type: 'text', expected: '42' }, answer, { attemptDir: root }))).status, 'error');
});

test('code testing supplies no expected answer to runner and compares every stdout independently', async t => {
  const { root, answer } = await fixture(t, 'print(input())');
  const seen = [], checker = code([{ input: '42\n', expected: '42' }, { input: '7\n', expected: '7' }]);
  const result = await assessExam(input(16, checker, answer, { attemptDir: root, runCode: async request => {
    seen.push(request); return { status: 'ok', stdout: request.input, durationMs: 1 };
  } }));
  assert.equal(row(result).status, 'correct'); assert.equal(row(result).tests.length, 2);
  assert.equal(Buffer.isBuffer(seen[0].source), true);
  assert.equal(seen[0].source.toString(), 'print(input())');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['input', 'language', 'resources', 'source']);
  const failed = await assessExam(input(16, checker, answer, { attemptDir: root,
    runCode: async request => ({ status: 'ok', stdout: request.input + 'debug\n' }) }));
  assert.equal(row(failed).status, 'incorrect');
  assert.equal(row(failed).tests.every(test => test.status === 'incorrect'), true);
});

test('exact program comparison and empty stdout do not use truthiness', async t => {
  const { root, answer } = await fixture(t, 'pass');
  for (const [expected, stdout, comparison, status] of [['42', '42\n', 'exact', 'incorrect'],
    ['42\n', '42\r\n', 'exact', 'correct'], ['', '', 'exact', 'correct'], ['', 'debug', 'trim', 'incorrect']]) {
    const result = await assessExam(input(16, code([{ input: '', expected }], { comparison }), answer,
      { attemptDir: root, runCode: async () => ({ status: 'ok', stdout }) }));
    assert.equal(row(result).status, status);
  }
});

test('sandbox failures remain distinct from wrong output, runtime failure and timeout', async t => {
  const { root, answer } = await fixture(t, 'print(42)');
  const run = runner => assessExam(input(16, code(), answer, { attemptDir: root, runCode: runner }));
  assert.equal(row(await run(undefined)).status, 'unavailable');
  for (const [execution, expected] of [[{ status: 'unavailable', message: 'Нет sandbox.' }, 'unavailable'],
    [{ status: 'timeout' }, 'incorrect'], [{ status: 'error', reason: 'runtime' }, 'incorrect'],
    [{ status: 'error', reason: 'infrastructure' }, 'error'], [{ status: 'error', reason: 'limit' }, 'error'],
    [{ status: 'error', reason: 'output' }, 'incorrect'], [{ status: 'error' }, 'error'],
    [{ status: 'ok', stdout: '42', exitCode: 1 }, 'incorrect'], [{ status: 'ok', stdout: '42', signal: 'SIGKILL' }, 'incorrect'],
    [{ status: 'ok', stdout: '' }, 'incorrect'], [{ status: 'ok', stdout: 42 }, 'error'],
    [{ status: 'ok', stdout: 'x'.repeat(LIMITS.outputBytes + 1) }, 'error'],
    [{ status: 'passed', stdout: '42' }, 'error'], [null, 'error']]) {
    const result = await run(async () => execution); assert.equal(row(result).status, expected);
  }
  assert.equal(row(await run(async () => { throw new Error('spawn failed'); })).status, 'error');
  const invalidUtf8 = await run(async () => ({ status: 'error', reason: 'output', message: 'Вывод программы должен быть текстом UTF-8.' }));
  assert.equal(row(invalidUtf8).status, 'incorrect');
  assert.equal(row(invalidUtf8).tests[0].message, 'Вывод программы должен быть текстом UTF-8.');
});

test('changed or unsupported source never executes and later task checks can continue', async t => {
  const { root, answer } = await fixture(t, Buffer.alloc(LIMITS.sourceBytes + 1, 'x'));
  let calls = 0;
  const exam = { tasks: [{ id: 13, checker: code(), resources: [] }, { id: 14, checker: { type: 'text', expected: '42' }, resources: [] }] };
  const second = await fixture(t, '42');
  await fsp.copyFile(second.file, path.join(root, second.answer.file.path));
  const result = await assessExam({ exam, attempt: { answers: { 13: answer, 14: second.answer } }, attemptDir: root,
    runCode: () => { calls++; } });
  assert.deepEqual(result.tasks.map(task => task.status), ['error', 'correct']); assert.equal(calls, 0);
});

test('code resources are checked against original exam assets before entering runner', async t => {
  const { root, answer } = await fixture(t, 'print(42)');
  const assetId = crypto.randomUUID(), resourcePath = `assets/${assetId}.bin`, data = Buffer.from('42\n');
  await fsp.mkdir(path.join(root, 'assets')); await fsp.writeFile(path.join(root, resourcePath), data);
  const request = input(13, code(), answer, { attemptDir: root, examDir: root });
  request.exam.tasks[0].resources = [{ name: 'data.txt', path: resourcePath, size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex') }];
  let calls = 0;
  request.runCode = async value => { calls++; assert.deepEqual(value.resources, [{ name: 'data.txt', file: path.join(root, resourcePath) }]);
    return { status: 'ok', stdout: '42' }; };
  assert.equal(row(await assessExam(request)).status, 'correct');
  request.exam.tasks[0].resources[0].sha256 = '0'.repeat(64);
  assert.equal(row(await assessExam(request)).status, 'error'); assert.equal(calls, 1);
});
