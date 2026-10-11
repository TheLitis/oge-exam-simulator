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
