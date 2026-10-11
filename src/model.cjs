'use strict';
const { promisify } = require('node:util');
const { fsp, path, crypto, check, safeName, safeRelative, inside, hashFile, rasterMime, LIMITS } = require('./io.cjs');
const scrypt = promisify(crypto.scrypt);
const { validateChecker } = require('./grading.cjs');
const DURATION = 9000;
const IMAGE_NAME = /^(\d{1,2})\.(\d+)\.(png|jpe?g|gif|webp|bmp)$/i;
const lexical = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
function taskKind(id) { check(Number.isInteger(id) && id >= 1 && id <= 16, 'Номер задания должен быть от 1 до 16.'); return id <= 12 ? 'short' : 'file'; }
const hasResources = id => id >= 11 && id <= 14;
function blankExam() { return { format: 'oge-exam', version: 1, id: crypto.randomUUID(), title: 'ОГЭ по информатике · Вариант 1', durationSeconds: DURATION, published: false, activation: null, tasks: Array.from({ length: 16 }, (_, i) => ({ id: i + 1, images: [], resources: [] })) }; }
function parseImageName(name) { const m = name.match(IMAGE_NAME); return m && +m[1] >= 1 && +m[1] <= 16 ? { taskId: +m[1], image: m[2], ext: m[3].toLowerCase() } : null; }
async function activation(code) {
  check(typeof code === 'string' && code.trim().length >= 6 && code.trim().length <= 128, 'Код активации должен содержать от 6 до 128 символов.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(code.trim(), salt, 32)).toString('hex');
  return { algorithm: 'scrypt', salt, hash };
}
async function verifyCode(code, record) {
  if (typeof code !== 'string' || code.length > 128 || !record) return false;
  const actual = await scrypt(code.trim(), record.salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}
function candidate(input) {
  check(input && typeof input === 'object', 'Заполните регистрационные данные.');
  const result = {};
  for (const key of ['registration', 'surname', 'name', 'passportSeries', 'passportNumber']) {
    check(typeof input[key] === 'string' && input[key].trim().length > 0 && input[key].length <= 80, 'Все поля регистрации обязательны.');
    result[key] = input[key].trim();
  }
  check(/^\d{1,32}$/.test(result.registration), 'Номер бланка должен содержать только цифры, от 1 до 32 знаков.');
  for (const key of ['surname', 'name']) check(/^[\p{L}\p{M} '’\-]+$/u.test(result[key]), 'Имя и фамилия должны содержать буквы, пробелы или дефис.');
  check(/^\d{4}$/.test(result.passportSeries), 'Серия паспорта: 4 цифры.');
  check(/^\d{6}$/.test(result.passportNumber), 'Номер паспорта: 6 цифр.');
  return result;
}
function validateShape(exam, requirePublished = false) {
  check(exam && exam.format === 'oge-exam' && exam.version === 1, 'Неподдерживаемый формат экзамена.');
  check(typeof exam.id === 'string' && /^[a-f0-9-]{36}$/.test(exam.id), 'Некорректный идентификатор экзамена.');
  check(typeof exam.title === 'string' && exam.title.trim().length > 0 && exam.title.length <= 160, 'Название экзамена должно содержать от 1 до 160 символов.');
  check(exam.durationSeconds === DURATION, 'Продолжительность экзамена должна быть ровно 150 минут.');
  check(typeof exam.published === 'boolean', 'Некорректное состояние экзамена.');
  if (requirePublished) check(exam.published, 'Это проект, а не опубликованный экзамен. Откройте его в редакторе и экспортируйте экзамен.');
  if (exam.activation !== null) {
    const a = exam.activation;
    check(a && a.algorithm === 'scrypt' && /^[0-9a-f]{32}$/.test(a.salt) && /^[0-9a-f]{64}$/.test(a.hash), 'Некорректный код активации в пакете.');
  }
  check(Array.isArray(exam.tasks) && exam.tasks.length === 16, 'В экзамене должно быть ровно 16 заданий.');
  const ids = new Set(); let count = 1, total = 0;
  for (let i = 0; i < 16; i++) {
    const task = exam.tasks[i]; check(task && task.id === i + 1, 'Задания должны идти от 1 до 16.');
    validateChecker(task.id, task.checker);
    check(Array.isArray(task.images) && task.images.length <= 16 && Array.isArray(task.resources) && task.resources.length <= 16, 'Слишком много файлов в задании (максимум 16 каждого типа).');
    check(hasResources(task.id) || task.resources.length === 0, 'Исходные файлы допустимы только в заданиях 11–14.');
    if (exam.published || requirePublished) {
      check(task.images.length > 0, `В задании ${task.id} нет изображения условия.`);
      check(!hasResources(task.id) || task.resources.length > 0, `В задании ${task.id} нет исходных файлов для работы.`);
    }
    const names = new Set();
    for (const [type, assets] of [['image', task.images], ['resource', task.resources]]) {
      for (const asset of assets) {
        check(asset && typeof asset === 'object' && /^[a-f0-9-]{36}$/.test(asset.id), 'Некорректный идентификатор файла.');
        check(!ids.has(asset.id), 'Идентификаторы файлов повторяются.'); ids.add(asset.id);
        safeName(asset.name); safeRelative(asset.path);
        check(asset.path.startsWith(`assets/${asset.id}.`), 'Некорректное имя ресурса.');
        check(Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.size <= (type === 'image' ? LIMITS.image : LIMITS.file), 'Недопустимый размер файла.');
        check(/^[0-9a-f]{64}$/.test(asset.sha256), 'Некорректная контрольная сумма.');
        const nk = `${type}:${asset.name.toLowerCase()}`; check(!names.has(nk), 'В задании есть файлы с одинаковым именем.'); names.add(nk);
        if (type === 'image') {
          check(/\.(png|jpe?g|gif|webp|bmp)$/i.test(asset.path), 'Неподдерживаемый формат изображения.');
          check(typeof asset.mime === 'string' && /^image\/(png|jpeg|gif|webp|bmp)$/.test(asset.mime), 'Некорректный тип изображения.');
        } else check(asset.path.endsWith('.bin'), 'Неподдерживаемый путь исходного файла.');
        count++; total += asset.size;
      }
    }
  }
  check(count <= LIMITS.entries && total <= LIMITS.expanded - LIMITS.json, 'Экзамен содержит слишком много данных.');
  if (exam.published || requirePublished) check(exam.activation, 'Не установлен код активации.');
  return exam;
}
async function validateFiles(exam, dir, requirePublished = false) {
  validateShape(exam, requirePublished);
  for (const task of exam.tasks) {
    for (const asset of [...task.images, ...task.resources]) {
      const file = inside(dir, asset.path); const st = await fsp.lstat(file);
      check(st.isFile() && !st.isSymbolicLink() && st.size === asset.size, 'Исходный файл отсутствует или повреждён.');
      check(await hashFile(file) === asset.sha256, 'Контрольная сумма исходного файла не совпадает.');
      if (task.images.includes(asset)) {
        const h = await fsp.open(file, 'r'); const b = Buffer.alloc(16);
        try { await h.read(b, 0, 16, 0); } finally { await h.close(); }
        check(rasterMime(b, path.extname(asset.path).slice(1)) === asset.mime, 'Тип изображения не совпадает с содержимым.');
      }
    }
  }
}
function answered(answer) { return !!answer && (answer.kind === 'short' ? answer.text.trim().length > 0 : !!answer.file); }
function dirty(attempt, id) {
  if (taskKind(id) === 'short') return attempt.drafts[id] !== undefined && attempt.drafts[id] !== (attempt.answers[id]?.text ?? '');
  return !!attempt.draftFiles[id] && attempt.draftFiles[id].id !== attempt.answers[id]?.file?.id;
}
module.exports = { DURATION, taskKind, hasResources, blankExam, parseImageName, lexical, activation, verifyCode, candidate, validateShape, validateFiles, answered, dirty };
