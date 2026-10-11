'use strict';

const { TextDecoder } = require('node:util');
const { constants } = require('node:fs');
const { fsp, path, crypto, check } = require('./io.cjs');
const { OFFICE_LIMITS, validateOfficeChecker, officeAssessment } = require('./office-grading.cjs');

const LIMITS = Object.freeze({ answers: 16, answerChars: 4096, answerBytes: 16 * 1024, tests: 16,
  testBytes: 16 * 1024, checkerBytes: 64 * 1024, textFileBytes: 1024 * 1024, sourceBytes: 256 * 1024,
  outputBytes: 64 * 1024, resources: 16, resourceBytes: 16 * 1024 * 1024, totalResourceBytes: 32 * 1024 * 1024 });
const STATUSES = ['correct', 'incorrect', 'unanswered', 'manual', 'error', 'unavailable'];
const labels = Object.freeze({ correct: 'Верно', incorrect: 'Неверно', unanswered: 'Нет ответа',
  manual: 'Ручная проверка', error: 'Ошибка проверки', unavailable: 'Проверка недоступна' });

function object(value, message) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), message);
}
function fields(value, allowed) {
  check(Object.keys(value).every(key => allowed.includes(key)), 'Неизвестное поле настройки автопроверки.');
}
function bool(value, fallback) {
  check(value === undefined || typeof value === 'boolean', 'Настройка сравнения должна быть логическим значением.');
  return value === undefined ? fallback : value;
}
function string(value, bytes, label, chars = Infinity) {
  check(typeof value === 'string' && value.length <= chars && Buffer.byteLength(value, 'utf8') <= bytes
    && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value,
  `${label}: недопустимый текст или превышен допустимый размер.`);
  return value;
}
function comparison(value) {
  check(value === undefined || ['trim', 'exact'].includes(value), 'Недопустимый режим сравнения.');
  return value ?? 'trim';
}
function normalize(value, options = {}) {
  let text = value.replace(/\r\n?/g, '\n');
  if (options.ignoreWhitespace) text = text.replace(/\s/gu, '');
  else if (options.comparison !== 'exact') text = text.trim();
  return options.caseSensitive === false ? text.toLowerCase() : text;
}

// A missing checker is deliberately compatible with every existing version-1 exam.
function validateChecker(id, value) {
  check(Number.isInteger(id) && id >= 1 && id <= 16, 'Номер задания должен быть от 1 до 16.');
  if (value === null || value === undefined) return null;
  object(value, 'Некорректная настройка автопроверки.');
  let result;
  if (value.type === 'short') {
    check(id <= 12, 'Проверка краткого ответа доступна только в заданиях 1–12.');
    fields(value, ['type', 'answers', 'caseSensitive', 'ignoreWhitespace']);
    check(Array.isArray(value.answers) && value.answers.length > 0 && value.answers.length <= LIMITS.answers,
      `Укажите от 1 до ${LIMITS.answers} допустимых ответов.`);
    result = { type: 'short', answers: value.answers.map(answer => string(answer, LIMITS.answerBytes,
      'Правильный ответ', LIMITS.answerChars)), caseSensitive: bool(value.caseSensitive, true),
    ignoreWhitespace: bool(value.ignoreWhitespace, false) };
    check(result.answers.every(answer => normalize(answer, result).length > 0), 'Правильный краткий ответ не может быть пустым.');
    check(Buffer.byteLength(result.answers.join(''), 'utf8') <= LIMITS.answerBytes, 'Правильные ответы занимают слишком много места.');
  } else if (value.type === 'text') {
    check(id >= 13, 'Проверка текстового файла доступна только в заданиях 13–16.');
    fields(value, ['type', 'expected', 'comparison', 'caseSensitive']);
    result = { type: 'text', expected: string(value.expected, LIMITS.checkerBytes, 'Ожидаемый текст'),
      comparison: comparison(value.comparison), caseSensitive: bool(value.caseSensitive, true) };
  } else if (value.type === 'code') {
    check(id >= 13, 'Проверка программы доступна только в заданиях 13–16.');
    fields(value, ['type', 'language', 'tests', 'comparison']);
    check(['python', 'javascript'].includes(value.language), 'Для автопроверки программы выберите Python или JavaScript.');
    check(Array.isArray(value.tests) && value.tests.length > 0 && value.tests.length <= LIMITS.tests,
      `Укажите от 1 до ${LIMITS.tests} тестов программы.`);
    result = { type: 'code', language: value.language, tests: value.tests.map(item => {
      object(item, 'Некорректный тест программы.'); fields(item, ['input', 'expected']);
      return { input: string(item.input, LIMITS.testBytes, 'Входные данные'),
        expected: string(item.expected, LIMITS.testBytes, 'Ожидаемый вывод') };
    }), comparison: comparison(value.comparison) };
  } else if (['spreadsheet', 'presentation'].includes(value.type)) {
    check(id >= 13, 'Проверка документа доступна только в заданиях 13–16.');
    result = validateOfficeChecker(value);
  } else check(false, 'Неизвестный тип автопроверки.');
  check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= LIMITS.checkerBytes,
    'Настройка автопроверки занимает слишком много места.');
  return result;
}

function present(answer) {
  return answer?.kind === 'short' ? typeof answer.text === 'string' && answer.text.trim().length > 0
    : answer?.kind === 'file' && !!answer.file;
}

async function checkedFile(root, relative, metadata, maxBytes, requireHash = false) {
  check(typeof root === 'string' && typeof relative === 'string' && !path.isAbsolute(relative)
    && !relative.includes('\\') && !relative.split('/').some(part => !part || part === '.' || part === '..'),
  'Недопустимый путь файла ответа.');
  const absoluteRoot = await fsp.realpath(root), file = path.resolve(absoluteRoot, relative);
  check(file.startsWith(absoluteRoot + path.sep), 'Файл находится вне каталога проверки.');
  let current = absoluteRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    check(!(await fsp.lstat(current)).isSymbolicLink(), 'Ссылки в файлах проверки не допускаются.');
  }
  check((await fsp.lstat(file)).isFile(), 'Файл ответа не является обычным файлом.');
  check((await fsp.realpath(file)) === file, 'Файл находится вне каталога проверки.');
  const handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size <= maxBytes, 'Файл слишком велик для автопроверки или не является обычным файлом.');
    if (metadata.size !== undefined) check(Number.isSafeInteger(metadata.size) && metadata.size === stat.size,
      'Размер файла ответа не совпадает с сохранённым.');
    if (requireHash || metadata.sha256 !== undefined) check(typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256),
      'Некорректная контрольная сумма файла ответа.');
    // Read at most the checked size plus one byte, including if another process
    // grows the file after stat. A changing file cannot cause an unbounded read.
    const bounded = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await handle.read(bounded, length, bounded.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    check(length === stat.size, 'Файл ответа изменился во время проверки.');
    const data = bounded.subarray(0, length);
    if (metadata.sha256 !== undefined) check(crypto.createHash('sha256').update(data).digest('hex') === metadata.sha256,
      'Контрольная сумма файла ответа не совпадает.');
    return { file, data };
  } finally { await handle.close(); }
}
function decode(data) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { check(false, 'Файл должен содержать текст в кодировке UTF-8.'); }
  check(!text.includes('\0'), 'Двоичный файл не подходит для текстовой автопроверки.');
  return text;
}
function safeMessage(message, fallback) {
  return typeof message === 'string' && message.trim() ? message.slice(0, 1000) : fallback;
}
async function resourcesFor(task, examDir) {
  if (!task.resources?.length) return [];
  check(typeof examDir === 'string', 'Каталог исходных файлов экзамена недоступен.');
  check(Array.isArray(task.resources) && task.resources.length <= LIMITS.resources, 'Слишком много исходных файлов для запуска программы.');
  check(task.resources.every(resource => Number.isSafeInteger(resource.size) && resource.size >= 0)
    && task.resources.reduce((total, resource) => total + resource.size, 0) <= LIMITS.totalResourceBytes,
  'Исходные файлы программы превышают допустимый размер.');
  const result = [], names = new Set();
  for (const resource of task.resources) {
    check(typeof resource.name === 'string' && resource.name.length > 0 && resource.name.length <= 180
      && !/[\\/\x00-\x1f\x7f]/.test(resource.name) && resource.name !== '.' && resource.name !== '..',
    'Недопустимое имя исходного файла.');
    check(!names.has(resource.name.toLowerCase()), 'Повторяются имена исходных файлов.'); names.add(resource.name.toLowerCase());
    check(typeof resource.path === 'string' && /^assets\/[a-f0-9-]{36}\.bin$/.test(resource.path), 'Недопустимый путь исходного файла.');
    const entry = await checkedFile(examDir, resource.path, resource, LIMITS.resourceBytes, true);
    result.push({ name: resource.name, file: entry.file });
  }
  return result;
}
async function codeAssessment(task, checker, data, runCode, examDir) {
  if (typeof runCode !== 'function') return { status: 'unavailable', message: 'Изолированный запуск программ недоступен.' };
  const resources = await resourcesFor(task, examDir), tests = [];
  for (let index = 0; index < checker.tests.length; index++) {
    const test = checker.tests[index];
    let execution;
    try { execution = await runCode({ language: checker.language, source: data, input: test.input, resources }); }
    catch { return { status: 'error', message: 'Не удалось выполнить изолированную проверку программы.', tests }; }
    if (!execution || !['ok', 'timeout', 'error', 'unavailable'].includes(execution.status)) {
      return { status: 'error', message: 'Средство запуска вернуло некорректный результат.', tests };
    }
    if (execution.status === 'unavailable') return { status: 'unavailable',
      message: safeMessage(execution.message, 'Изолированный запуск программ недоступен.'), tests };
    if (execution.status === 'error' && !['runtime', 'output'].includes(execution.reason)) return { status: 'error',
      message: safeMessage(execution.message, 'Ошибка среды проверки программы.'), tests };
    const detail = { index: index + 1, status: 'incorrect' };
    if (Number.isFinite(execution.durationMs) && execution.durationMs >= 0) detail.durationMs = execution.durationMs;
    if (execution.status === 'timeout') detail.message = 'Превышено время выполнения.';
    else if (execution.status === 'error') detail.message = safeMessage(execution.message, execution.reason === 'output'
      ? 'Программа превысила допустимый объём вывода.' : 'Программа завершилась с ошибкой.');
    else if ((execution.exitCode !== undefined && execution.exitCode !== null && execution.exitCode !== 0) || execution.signal) {
      detail.message = 'Программа завершилась с ошибкой.';
    } else {
      if (typeof execution.stdout !== 'string' || Buffer.byteLength(execution.stdout, 'utf8') > LIMITS.outputBytes) {
        return { status: 'error', message: 'Средство запуска вернуло недопустимый вывод.', tests };
      }
      detail.actual = execution.stdout;
      detail.status = normalize(execution.stdout, checker) === normalize(test.expected, checker) ? 'correct' : 'incorrect';
      detail.message = detail.status === 'correct' ? 'Вывод совпадает.' : 'Вывод не совпадает.';
    }
    tests.push(detail);
  }
  const correct = tests.filter(test => test.status === 'correct').length;
  return { status: correct === tests.length ? 'correct' : 'incorrect',
    message: `Пройдено тестов: ${correct} из ${tests.length}.`, tests };
}

// Runs on explicit teacher review, never on draft edits or pupil submission.
// It returns observations, not a points scale or an official examination grade.
async function assessExam({ exam, attempt, attemptDir, examDir, runCode } = {}) {
  check(exam && Array.isArray(exam.tasks) && attempt && typeof attempt === 'object', 'Нет данных для проверки экзамена.');
  const tasks = [];
  let configured = 0;
  for (const task of exam.tasks) {
    const result = { id: task.id }, answer = attempt.answers?.[task.id];
    try {
      const checker = validateChecker(task.id, task.checker);
      if (checker) configured++;
      if (!present(answer)) Object.assign(result, { status: 'unanswered', message: 'Сохранённого ответа нет.' });
      else if (!checker) Object.assign(result, { status: 'manual', message: 'Автопроверка не настроена.' });
      else if (checker.type === 'short') {
        check(answer.kind === 'short', 'Тип ответа не соответствует заданию.');
        string(answer.text, LIMITS.answerBytes, 'Ответ ученика', LIMITS.answerChars);
        const actual = normalize(answer.text, checker), matches = checker.answers.some(expected => normalize(expected, checker) === actual);
        Object.assign(result, { status: matches ? 'correct' : 'incorrect', message: matches ? 'Ответ совпадает.' : 'Ответ не совпадает.', actual: answer.text });
      } else {
        check(answer.kind === 'file' && answer.file && /^blobs\/[a-f0-9-]{36}$/.test(answer.file.path), 'Некорректный файл ответа.');
        const entry = await checkedFile(attemptDir, answer.file.path, answer.file,
          ['spreadsheet', 'presentation'].includes(checker.type) ? OFFICE_LIMITS.fileBytes
            : checker.type === 'code' ? LIMITS.sourceBytes : LIMITS.textFileBytes, checker.type !== 'text');
        if (['spreadsheet', 'presentation'].includes(checker.type)) Object.assign(result, await officeAssessment(entry.data, checker));
        else if (checker.type === 'text') {
          const text = decode(entry.data);
          const matches = normalize(text, checker) === normalize(checker.expected, checker);
          Object.assign(result, { status: matches ? 'correct' : 'incorrect', message: matches ? 'Содержимое файла совпадает.' : 'Содержимое файла не совпадает.' });
        } else { decode(entry.data); Object.assign(result, await codeAssessment(task, checker, entry.data, runCode, examDir)); }
      }
    } catch (error) {
      Object.assign(result, { status: 'error', message: error.name === 'UserError' ? error.message : 'Файл ответа недоступен или не удалось выполнить проверку.' });
    }
    tasks.push(result);
  }
  const summary = { total: tasks.length, configured };
  for (const status of STATUSES) summary[status] = tasks.filter(task => task.status === status).length;
  return { version: 1, tasks, summary };
}

module.exports = { LIMITS, validateChecker, assessExam, normalize, labels };
