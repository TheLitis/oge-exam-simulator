'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fsp, path, crypto } = require('../src/io.cjs');
const { LIMITS, validateChecker, assessExam, previewReference } = require('../src/grading.cjs');
const { capabilities, runCode } = require('../src/code-runner.cjs');

const reference = { language: 'python', source: 'print(sum(map(int, __import__("sys").stdin.read().split())))' };
const code = (tests = [{ input: '20\n22\n' }], extra = {}) => ({ type: 'code', language: 'javascript', reference, tests, ...extra });
const row = result => result.tasks[0];
async function fixture(t, source = 'console.log(42);') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-reference-grading-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'blobs')); await fsp.mkdir(path.join(root, 'assets'));
  const id = crypto.randomUUID(), relative = `blobs/${id}`, bytes = Buffer.from(source);
  await fsp.writeFile(path.join(root, relative), bytes);
  const answer = { kind: 'file', file: { id, path: relative, name: 'answer.js', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  const request = checker => ({ exam: { tasks: [{ id: 16, checker, resources: [] }] },
    attempt: { answers: { 16: answer } }, attemptDir: root, examDir: root });
  return { root, source, request };
}
async function resource(root, name = 'numbers.txt', text = '20\n22\n') {
  const relative = `assets/${crypto.randomUUID()}.bin`, bytes = Buffer.from(text);
  await fsp.writeFile(path.join(root, relative), bytes);
  return { name, path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('reference schema preserves multiline stdin, both languages and missing vs explicit empty expected output', () => {
  const checker = code([{ input: '2\n20\n22\n' }, { input: '', expected: '' }, { input: '7\n', expected: '7' }], { comparison: 'exact' });
  assert.deepEqual(validateChecker(16, checker), checker);
  assert.equal(Object.hasOwn(validateChecker(16, checker).tests[0], 'expected'), false);
  assert.equal(Object.hasOwn(validateChecker(16, checker).tests[1], 'expected'), true);
  assert.deepEqual(validateChecker(13, code([{ input: '' }], {
    language: 'python', reference: { language: 'javascript', source: 'console.log(42)' }
  })).reference, { language: 'javascript', source: 'console.log(42)' });
});

test('reference settings fail closed on absent expected outputs, invalid source, extra fields and bounds', () => {
  for (const checker of [
    { type: 'code', language: 'python', tests: [{ input: '' }] },
    code([], {}), code(undefined, { reference: null }),
    code(undefined, { reference: { language: 'shell', source: 'echo 42' } }),
    code(undefined, { reference: { language: 'python', source: '' } }),
    code(undefined, { reference: { language: 'python', source: ' \n\t ' } }),
    code(undefined, { reference: { language: 'python', source: 'print(42)\0' } }),
    code(undefined, { reference: { language: 'python', source: '\ud800' } }),
    code(undefined, { reference: { language: 'python', source: 'print(42)', path: '/home/teacher/answer.py' } }),
    code(undefined, { reference: { language: 'python', source: 'a'.repeat(LIMITS.sourceBytes + 1) } }),
    code(undefined, { reference: { language: 'python', source: 'a'.repeat(LIMITS.checkerBytes) } }),
    code([{ input: 'a'.repeat(LIMITS.testBytes + 1) }]),
    code([{ input: '', expected: undefined }]), code([{ input: '', expected: null }]),
    code(Array.from({ length: LIMITS.tests + 1 }, () => ({ input: '' }))),
  ]) assert.throws(() => validateChecker(16, checker), { name: 'UserError' });
});

test('all reference outputs are prepared first; pupil calls receive only their source, stdin and public resources', async t => {
  const { source, request } = await fixture(t);
  const seen = [], checker = code([{ input: '20\n22\n' }, { input: '1\n6\n' }]);
  const result = await assessExam({ ...request(checker), runCode: async options => {
    seen.push(options);
    return { status: 'ok', stdout: options.input === '20\n22\n' ? '42\n' : '7\n', exitCode: 0, durationMs: 1 };
  } });
  assert.equal(row(result).status, 'correct');
  assert.deepEqual(seen.map(options => options.language), ['python', 'python', 'javascript', 'javascript']);
  assert.deepEqual(seen.map(options => options.input), ['20\n22\n', '1\n6\n', '20\n22\n', '1\n6\n']);
  for (const options of seen.slice(2)) {
    assert.deepEqual(Object.keys(options).sort(), ['input', 'language', 'resources', 'source']);
    assert.equal(options.source.toString(), source);
    assert.equal(options.source.includes(Buffer.from(reference.source)), false);
    assert.deepEqual(options.resources, []);
  }
  assert.equal(JSON.stringify(result).includes(reference.source), false);
  assert.deepEqual(row(result).tests.map(test => ({ input: test.input, expected: test.expected, actual: test.actual })),
    [{ input: '20\n22\n', expected: '42\n', actual: '42\n' }, { input: '1\n6\n', expected: '7\n', actual: '7\n' }]);
});

test('mixed manual and reference tests retain an explicit empty answer and exact comparison', async t => {
  const { request } = await fixture(t), seen = [];
  const checker = code([{ input: 'manual-empty', expected: '' }, { input: 'reference-empty' },
    { input: 'reference-lines\r\n' }, { input: 'manual-number', expected: '42' }], { comparison: 'exact' });
  const result = await assessExam({ ...request(checker), runCode: async options => {
    seen.push(options);
    return { status: 'ok', stdout: options.input === 'reference-lines\r\n'
      ? options.language === 'python' ? 'A\r\nB\r\n' : 'A\nB\n'
      : options.input === 'manual-number' ? '42\n' : '' };
  } });
  assert.deepEqual(seen.filter(options => options.language === 'python').map(options => options.input), ['reference-empty', 'reference-lines\r\n']);
  assert.equal(row(result).status, 'incorrect');
  assert.deepEqual(row(result).tests.map(result => result.status), ['correct', 'correct', 'correct', 'incorrect']);
});

test('a supplied reference is optional for all-manual tests and never runs unnecessarily', async t => {
  const { request } = await fixture(t), seen = [];
  const result = await assessExam({ ...request(code([{ input: 'unused', expected: '' }])), runCode: async options => {
    seen.push(options); return { status: 'ok', stdout: '' };
  } });
  assert.equal(row(result).status, 'correct'); assert.equal(seen.length, 1);
  assert.equal(seen[0].language, 'javascript');
  const old = { type: 'code', language: 'python', tests: [{ input: 'old-format', expected: '42' }] };
  assert.deepEqual(validateChecker(16, old), { ...old, comparison: 'trim' });
  assert.equal(row(await assessExam({ ...request(old), runCode: async () => ({ status: 'ok', stdout: '42\n' }) })).status, 'correct');
});

test('reference timeout, runtime, output and invalid results are checking errors before any pupil execution', async t => {
  const { request } = await fixture(t);
  for (const execution of [
    { status: 'timeout' }, { status: 'error', reason: 'runtime' }, { status: 'error', reason: 'output' },
    { status: 'error', reason: 'infrastructure' }, { status: 'error', reason: 'limit' },
    { status: 'ok', stdout: '42', exitCode: 1 }, { status: 'ok', stdout: '42', signal: 'SIGKILL' },
    { status: 'ok', stdout: 42 }, { status: 'ok', stdout: 'x'.repeat(LIMITS.outputBytes + 1) },
    { status: 'ok', stdout: '\ud800' }, { status: 'passed', stdout: '42' }, null,
  ]) {
    const seen = [], result = await assessExam({ ...request(code([{ input: 'good' }, { input: 'bad' }])), runCode: async options => {
      seen.push(options); return options.input === 'good' ? { status: 'ok', stdout: '42' } : execution;
    } });
    assert.equal(row(result).status, 'error', JSON.stringify(execution));
    assert.match(row(result).message, /Эталонное решение, тест 2/);
    assert.equal(result.summary.incorrect, 0); assert.deepEqual(row(result).tests, []);
    assert.equal(seen.length, 2); assert.equal(seen.every(options => options.language === 'python'), true);
  }
  const failed = await assessExam({ ...request(code()), runCode: async () => { throw new Error('Reference failure'); } });
  assert.equal(row(failed).status, 'error'); assert.match(row(failed).message, /Эталонное решение, тест 1/);
});

test('missing runner and unavailable reference runtime remain unavailable, not an incorrect pupil answer', async t => {
  const { request } = await fixture(t);
  assert.equal(row(await assessExam(request(code()))).status, 'unavailable');
  let calls = 0;
  const result = await assessExam({ ...request(code()), runCode: async () => { calls++; return { status: 'unavailable', message: 'Sandbox unavailable' }; } });
  assert.equal(row(result).status, 'unavailable'); assert.equal(calls, 1); assert.equal(result.summary.incorrect, 0);
});

test('teacher reference preview validates saved resources and runs only reference tests without a pupil submission', async t => {
  const { root } = await fixture(t), attached = await resource(root), seen = [];
  const checker = code([{ input: '', expected: '' }, { input: '20\n22\n' }]);
  const task = { id: 16, resources: [attached] };
  const preview = await previewReference({ task, checker, examDir: root, runCode: async options => {
    seen.push(options); return { status: 'ok', stdout: '42\n', durationMs: 2 };
  } });
  assert.deepEqual(preview, { status: 'ok', tests: [
    { index: 1, input: '', expected: '', source: 'manual' },
    { index: 2, input: '20\n22\n', expected: '42\n', source: 'reference', durationMs: 2 }
  ] });
  assert.equal(seen.length, 1); assert.equal(seen[0].source.toString(), reference.source);
  assert.equal(JSON.stringify(preview).includes(reference.source), false);
  assert.equal(JSON.stringify(preview).includes(root), false);
  attached.sha256 = '0'.repeat(64);
  await assert.rejects(previewReference({ task, checker, examDir: root, runCode: async () => { throw new Error('Must not run'); } }), /Контрольная сумма/);
  assert.equal((await previewReference({ task, checker, examDir: root })).status, 'unavailable');
  await assert.rejects(previewReference({ task, checker: { type: 'code', language: 'python', tests: [{ input: '', expected: '' }] } }), /эталонное решение/);
});

test('both sources receive the same verified file condition with empty stdin; bad hashes stop both', async t => {
  const { root, request } = await fixture(t), attached = await resource(root), seen = [];
  const data = request(code([{ input: '' }], { reference: { language: 'python', source: 'print(open("numbers.txt").read())' } }));
  data.exam.tasks[0].resources = [attached];
  data.runCode = async options => {
    seen.push(options); assert.equal(options.input, '');
    assert.deepEqual(options.resources, [{ name: 'numbers.txt', file: path.join(root, attached.path) }]);
    assert.equal(await fsp.readFile(options.resources[0].file, 'utf8'), '20\n22\n');
    return { status: 'ok', stdout: '42' };
  };
  assert.equal(row(await assessExam(data)).status, 'correct'); assert.equal(seen.length, 2);
  attached.sha256 = '0'.repeat(64);
  assert.equal(row(await assessExam(data)).status, 'error'); assert.equal(seen.length, 2);
});

test('Linux reference and pupil programs use isolated sandboxes with shared file conditions', { timeout: 30000,
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 }, async t => {
  const state = await capabilities();
  if (!state.available) {
    assert.notEqual(process.env.OGE_SANDBOX_REQUIRED, '1', 'Required sandbox must be available on the MOS stand.');
    t.skip('bubblewrap/prlimit or unprivileged namespaces are unavailable'); return;
  }
  assert.equal(state.languages.python, true); assert.equal(state.languages.javascript, true);
  const source = 'const fs=require("fs"),assert=require("assert");assert.deepEqual(fs.readdirSync(".").sort(),["numbers.txt","source.cjs"]);console.log(fs.readFileSync("numbers.txt","utf8").trim().split(/\\s+/).reduce((sum,v)=>sum+Number(v),0)+fs.readFileSync(0,"utf8").trim().split(/\\s+/).reduce((sum,v)=>sum+Number(v||0),0));';
  const { root, request } = await fixture(t, source), attached = await resource(root, 'numbers.txt', '20\n22\n');
  const checker = code([{ input: '' }, { input: '1\n2\n' }], {
    reference: { language: 'python', source: 'import sys\nprint(sum(map(int, open("numbers.txt").read().split()))+sum(map(int,sys.stdin.read().split())))\n' }
  });
  const data = request(checker); data.exam.tasks[0].resources = [attached]; data.runCode = runCode;
  const result = await assessExam(data);
  assert.equal(row(result).status, 'correct', JSON.stringify(row(result)));
  assert.deepEqual(row(result).tests.map(result => result.actual), ['42\n', '45\n']);
  // A checker error must not be counted as a pupil error, even in the real runner.
  checker.reference.source = 'raise ValueError("synthetic reference failure")';
  const failed = await assessExam(data);
  assert.equal(row(failed).status, 'error', JSON.stringify(row(failed)));
  assert.match(row(failed).message, /Эталонное решение, тест 1/);
  assert.equal(failed.summary.incorrect, 0); assert.deepEqual(row(failed).tests, []);
});
