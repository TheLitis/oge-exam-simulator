'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function page(fetch, URL = { revokeObjectURL() {} }) {
  const element = { addEventListener() {}, querySelector() { return null; } };
  const context = vm.createContext({
    fetch, URL, V: {}, location: { hash: '', pathname: '/' },
    sessionStorage: { getItem() { return null; } },
    document: { querySelector() { return element; }, addEventListener() {} },
    window: { addEventListener() {} }, setInterval() {}, clearTimeout() {}
  });
  const source = await fs.readFile(path.join(__dirname, '../ui/app.js'), 'utf8');
  vm.runInContext(source.replace(/^import .*?;\r?\n/, '').replace(/\r?\nboot\(\);/, ''), context);
  vm.runInContext("teacherToken = 'synthetic-teacher-token'; state.data = { teacher: { unlocked: true }, editor: { tasks: [] } };", context);
  return context;
}

test('late teacher state cannot restore references after the teacher view was cleared', async () => {
  let deliver;
  const body = new Promise(resolve => { deliver = resolve; });
  const context = await page(async () => ({ ok: true, json: () => body }));
  const pending = vm.runInContext('refresh()', context);
  vm.runInContext('clearTeacherView()', context);
  deliver({ ok: true, value: { teacher: { unlocked: true }, editor: { tasks: [{ checker: { expected: 'synthetic-reference' } }] } } });
  await assert.rejects(pending, { code: 'TEACHER_SESSION_CHANGED' });
  assert.equal(vm.runInContext('state.data.editor', context), null);
  assert.equal(vm.runInContext('teacherToken', context), null);
});

test('teacher state is checked again when its request has resolved but has not been applied', async () => {
  const context = await page(async () => ({ ok: true, json: async () => ({ ok: true, value: {
    teacher: { unlocked: true }, editor: { tasks: [{ checker: { expected: 'synthetic-reference' } }] }
  } }) }));
  const pending = vm.runInContext(`
    const originalRequest = request;
    request = (...args) => {
      const response = originalRequest(...args);
      response.then(() => clearTeacherView());
      return response;
    };
    refresh();
  `, context);
  await assert.rejects(pending, { code: 'TEACHER_SESSION_CHANGED' });
  assert.equal(vm.runInContext('state.data.editor', context), null);
});

test('late teacher report cannot initiate a download after the teacher view was cleared', async () => {
  let deliver, started, objectUrls = 0;
  const blob = new Promise(resolve => { deliver = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const context = await page(async () => ({ ok: true, blob() { started(); return blob; } }), {
    revokeObjectURL() {}, createObjectURL() { objectUrls++; return 'synthetic-blob'; }
  });
  const pending = vm.runInContext("download('/api/review/report?id=synthetic', 'report.zip')", context);
  await reading;
  vm.runInContext('clearTeacherView()', context);
  deliver({});
  await assert.rejects(pending, { code: 'TEACHER_SESSION_CHANGED' });
  assert.equal(objectUrls, 0);
});

test('late reference preview cannot restore expected outputs after teacher lock', async () => {
  let deliver, started;
  const body = new Promise(resolve => { deliver = resolve; });
  const fetching = new Promise(resolve => { started = resolve; });
  const context = await page(async () => { started(); return { ok: true, json: () => body }; });
  vm.runInContext("state.mode = 'editor'; state.editorTask = 16; checkerDrafts.set(16, { referencePreview: null }); flushEditor = async () => {};", context);
  const pending = vm.runInContext("actions['reference-preview']()", context);
  await fetching;
  vm.runInContext('clearTeacherView()', context);
  deliver({ ok: true, value: { status: 'ok', tests: [{ index: 1, expected: 'synthetic-private-output' }] } });
  await assert.rejects(pending, { code: 'TEACHER_SESSION_CHANGED' });
  assert.equal(vm.runInContext('checkerDrafts.size', context), 0);
  assert.equal(vm.runInContext('state.data.editor', context), null);
});

test('opening the results folder does not ask for or change teacher access', async () => {
  const calls = [];
  const context = await page(async (route, options) => {
    calls.push({ route, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, value: true }) };
  });
  vm.runInContext(`
    ensureTeacher = async () => { throw new Error('Unexpected teacher prompt'); };
    lockTeacher = async () => { throw new Error('Unexpected teacher lock'); };
  `, context);
  await vm.runInContext("actions['open-results']()", context);
  assert.deepEqual(calls, [{ route: '/api/open-folder', body: { root: true } }]);
  assert.equal(vm.runInContext('teacherToken', context), 'synthetic-teacher-token');
});

test('result download uses an anonymous name and preserves the encrypted extension', async () => {
  const context = await page(async () => { throw new Error('Unexpected request'); });
  vm.runInContext(`
    var capturedDownload;
    download = async (route, name) => { capturedDownload = { route, name }; };
    toast = () => {};
    state.data.session = { encrypted: true, candidate: { registration: 'synthetic-private-registration' } };
  `, context);
  await vm.runInContext("actions['download-result']()", context);
  assert.equal(vm.runInContext('capturedDownload.route', context), '/api/result');
  assert.equal(vm.runInContext('capturedDownload.name', context), 'result.ogeresult');
  vm.runInContext("state.data.session.archiveName = 'result_123.ogeresult';", context);
  await vm.runInContext("actions['download-result']()", context);
  assert.equal(vm.runInContext('capturedDownload.name', context), 'result_123.ogeresult');
});

test('key import retries the source password and keeps it out of the URL', async () => {
  const attempts = [];
  const context = await page(async (route, options) => {
    attempts.push({ route, headers: { ...options.headers } });
    const code = attempts.length === 1 ? 'RESULT_KEY_PASSWORD_REQUIRED' : 'RESULT_KEY_PASSWORD_INVALID';
    return { ok: attempts.length === 3, json: async () => attempts.length === 3
      ? { ok: true, value: { ready: true } } : { ok: false, code, error: 'Synthetic key password prompt' } };
  });
  vm.runInContext(`
    var askedTitles = [];
    projectPassword = async (message, title) => { askedTitles.push(title); return askedTitles.length === 1 ? 'synthetic wrong' : 'synthetic correct'; };
  `, context);
  const result = await vm.runInContext("importResultKey({ name: 'keys.ogekeys' })", context);
  assert.equal(result.ready, true);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.route === '/api/upload?kind=result-key&name=keys.ogekeys'));
  assert.equal(attempts[0].headers['X-Project-Password'], undefined);
  assert.equal(attempts[1].headers['X-Project-Password'], 'synthetic%20wrong');
  assert.equal(attempts[2].headers['X-Project-Password'], 'synthetic%20correct');
  assert.equal(vm.runInContext("askedTitles.join(',')", context), 'Пароль ключа,Пароль ключа');
});

test('a key password prompt cannot resume import after the teacher view was cleared', async () => {
  let requests = 0;
  const context = await page(async () => {
    requests++;
    return { ok: false, json: async () => ({ ok: false, code: 'RESULT_KEY_PASSWORD_REQUIRED', error: 'Synthetic prompt' }) };
  });
  vm.runInContext("projectPassword = async () => { clearTeacherView(); return 'synthetic password'; };", context);
  await assert.rejects(vm.runInContext("importResultKey({ name: 'keys.ogekeys' })", context), { code: 'TEACHER_SESSION_CHANGED' });
  assert.equal(requests, 1);
});

test('result screen describes encryption only when the saved work is encrypted', async () => {
  const source = await fs.readFile(path.join(__dirname, '../ui/views.js'), 'utf8');
  const context = vm.createContext({ document: { documentElement: { dataset: { theme: 'dark' } } } });
  vm.runInContext(source.replace(/export /g, ''), context);
  const input = {
    session: {
      encrypted: true, archiveReady: true, title: 'Synthetic exam',
      candidate: { surname: 'Synthetic', name: 'Candidate', registration: '123' },
      savedCount: 1, statuses: [], dirtyCount: 0, resultDir: 'synthetic-results'
    }
  };
  context.input = input;
  const encrypted = vm.runInContext('result(input)', context);
  assert.match(encrypted, /Работа зашифрована/);
  assert.match(encrypted, /Скачать работу/);
  assert.doesNotMatch(encrypted, /Скачать ZIP|не зашифрована/);
  input.session.encrypted = false;
  assert.match(vm.runInContext('result(input)', context), /не зашифрована/);
  input.session.encrypted = true; input.session.candidate = { surname: '', name: '', registration: '' };
  const receipt = vm.runInContext('result(input)', context);
  assert.match(receipt, /<h2>Synthetic exam<\/h2>/); assert.doesNotMatch(receipt, /Бланк|<h2>\s*<\/h2>/);
});
