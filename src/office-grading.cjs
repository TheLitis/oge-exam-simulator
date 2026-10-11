'use strict';

const { check } = require('./io.cjs');

const OFFICE_LIMITS = Object.freeze({ criteria: 32, fileBytes: 32 * 1024 * 1024, sheets: 256, slides: 256 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed) {
  check(plain(value), 'Некорректный критерий проверки документа.');
  check(Object.keys(value).every(key => allowed.includes(key)), 'Неизвестное поле критерия проверки документа.');
}
function text(value, label, maximum = 4096) {
  check(typeof value === 'string' && value.length <= maximum && !value.includes('\0')
    && Buffer.from(value, 'utf8').toString('utf8') === value, `${label}: недопустимый текст или превышен размер.`);
  return value;
}
function sheet(value) {
  const name = text(value, 'Имя листа', 128).trim();
  check(name.length > 0, 'Укажите имя листа.'); return name;
}
function integer(value, min, max, label) {
  check(Number.isInteger(value) && value >= min && value <= max, `${label}: укажите целое число от ${min} до ${max}.`);
  return value;
}
function boolean(value, fallback) {
  check(value === undefined || typeof value === 'boolean', 'Настройка регистра должна быть логическим значением.');
  return value ?? fallback;
}
function address(value) {
  const cell = text(value, 'Адрес ячейки', 16).trim().toUpperCase();
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(cell);
  let column = 0; if (match) for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  check(match && column <= 16384 && Number(match[2]) <= 1048576, 'Укажите адрес одной ячейки, например A1 (до XFD1048576).');
  return cell;
}
function number(value) {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized.replace(',', '.')); return Number.isFinite(parsed) ? parsed : null;
}
function validateOfficeChecker(value) {
  fields(value, ['type', 'criteria']);
  check(['spreadsheet', 'presentation'].includes(value.type), 'Неизвестный тип документа для проверки.');
  check(Array.isArray(value.criteria) && value.criteria.length > 0 && value.criteria.length <= OFFICE_LIMITS.criteria,
    `Укажите от 1 до ${OFFICE_LIMITS.criteria} критериев проверки документа.`);
  const criteria = value.criteria.map(item => {
    check(plain(item), 'Некорректный критерий проверки документа.');
    if (value.type === 'spreadsheet') {
      if (item.kind === 'cellValue') {
        check(['text', 'number'].includes(item.mode), 'Выберите текст или число для значения ячейки.');
        fields(item, item.mode === 'number' ? ['kind', 'sheet', 'cell', 'mode', 'expected', 'tolerance']
          : ['kind', 'sheet', 'cell', 'mode', 'expected', 'caseSensitive']);
        const result = { kind: item.kind, sheet: sheet(item.sheet), cell: address(item.cell), mode: item.mode,
          expected: text(item.expected, 'Ожидаемое значение') };
        if (item.mode === 'number') {
          check(number(result.expected) !== null, 'Ожидаемое значение должно быть конечным числом.');
          check(item.tolerance === undefined || (typeof item.tolerance === 'number' && Number.isFinite(item.tolerance)
            && item.tolerance >= 0), 'Допуск должен быть конечным неотрицательным числом.');
          result.tolerance = item.tolerance ?? 0;
        } else result.caseSensitive = boolean(item.caseSensitive, true);
        return result;
      }
      if (item.kind === 'cellFormula') {
        fields(item, ['kind', 'sheet', 'cell', 'expected']);
        const expected = text(item.expected, 'Ожидаемая формула');
        check(normalizeFormula(expected).length > 0, 'Укажите ожидаемую формулу.');
        return { kind: item.kind, sheet: sheet(item.sheet), cell: address(item.cell), expected };
      }
      if (item.kind === 'sheetCount') {
        fields(item, ['kind', 'expected']);
        return { kind: item.kind, expected: integer(item.expected, 1, OFFICE_LIMITS.sheets, 'Число листов') };
      }
      if (item.kind === 'sheetExists') {
        fields(item, ['kind', 'sheet']); return { kind: item.kind, sheet: sheet(item.sheet) };
      }
      if (item.kind === 'chartCount') {
        fields(item, ['kind', 'sheet', 'minimum']);
        return { kind: item.kind, sheet: sheet(item.sheet), minimum: integer(item.minimum, 1, 1024, 'Минимум диаграмм') };
      }
    } else {
      if (item.kind === 'slideCount') {
        fields(item, ['kind', 'expected']);
        return { kind: item.kind, expected: integer(item.expected, 1, OFFICE_LIMITS.slides, 'Число слайдов') };
      }
      if (item.kind === 'slideText') {
        fields(item, ['kind', 'slide', 'expected', 'comparison', 'caseSensitive']);
        const expected = text(item.expected, 'Ожидаемый текст'); check(expected.trim().length > 0, 'Укажите текст слайда.');
        check(item.comparison === undefined || ['contains', 'exact'].includes(item.comparison), 'Недопустимый режим сравнения текста слайда.');
        return { kind: item.kind, slide: integer(item.slide, 1, OFFICE_LIMITS.slides, 'Номер слайда'), expected,
          comparison: item.comparison ?? 'contains', caseSensitive: boolean(item.caseSensitive, true) };
      }
      if (item.kind === 'imageCount') {
        fields(item, ['kind', 'slide', 'minimum']);
        return { kind: item.kind, slide: integer(item.slide, 1, OFFICE_LIMITS.slides, 'Номер слайда'),
          minimum: integer(item.minimum, 1, 1024, 'Минимум изображений') };
      }
    }
    check(false, 'Этот критерий не подходит для выбранного типа документа.');
  });
  return { type: value.type, criteria };
}

// Compare the saved formula, never calculate it. Preserve quoted literals;
// canonicalize only function case, whitespace, separators and local ODF references.
function normalizeFormula(value) {
  const body = value.trim().replace(/^(?:of:|oooc:)?=/i, '').trim();
  let arrayDepth = 0;
  return body.split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/g).map((part, index) => {
    if (index % 2) return part;
    // A space between references is Excel's intersection operator. Preserve it;
    // only discard cosmetic spacing beside operators and inside parentheses.
    const result = part.replace(/\s+/gu, ' ').toUpperCase().replace(/\s*([,+\-*/^&=<>;:%])\s*/g, '$1')
      .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/[{};]/g, char => {
      if (char === '{') arrayDepth++; else if (char === '}') arrayDepth--;
      return char === ';' && arrayDepth === 0 ? ',' : char;
    });
    return result.replace(/\[\.(\$?[A-Z]{1,3}\$?[1-9]\d*)(?::\.(\$?[A-Z]{1,3}\$?[1-9]\d*))?\]/g,
      (_, start, end) => end ? `${start}:${end}` : start);
  }).join('');
}
function normalizeText(value, caseSensitive = true) {
  const result = value.replace(/\r\n?/g, '\n').trim(); return caseSensitive ? result : result.toLowerCase();
}
function criterionLabel(item) {
  return ({ cellValue: `Значение ${item.sheet}!${item.cell}`, cellFormula: `Формула ${item.sheet}!${item.cell}`,
    sheetCount: 'Число листов', sheetExists: `Лист «${item.sheet}»`, chartCount: `Диаграммы: ${item.sheet}`,
    slideCount: 'Число слайдов', slideText: `Текст слайда ${item.slide}`, imageCount: `Изображения на слайде ${item.slide}` })[item.kind];
}
function assessOfficeDocument(document, checker) {
  const criteria = checker.criteria.map((item, index) => {
    const detail = { index: index + 1, label: criterionLabel(item) };
    const compare = (matches, actual, expected) => Object.assign(detail, { status: matches ? 'correct' : 'incorrect',
      message: matches ? 'Критерий выполнен.' : 'Критерий не выполнен.', actual: String(actual).slice(0, 4096), expected: String(expected).slice(0, 4096) });
    const failure = message => Object.assign(detail, { status: 'error', message });
    if (checker.type === 'spreadsheet') {
      if (item.kind === 'sheetCount') return compare(document.sheets.length === item.expected, document.sheets.length, item.expected);
      const target = document.sheets.find(entry => entry.name === item.sheet);
      if (item.kind === 'sheetExists') return compare(!!target, target ? 'Есть' : 'Нет', 'Есть');
      if (!target) return compare(false, 'Лист отсутствует', item.sheet);
      if (item.kind === 'chartCount') return compare(target.charts >= item.minimum, target.charts, `Не менее ${item.minimum}`);
      const cell = target.cells[item.cell];
      if (item.kind === 'cellFormula') {
        if (cell?.formulaSupported === false) return failure('Формула этой ячейки требует развёртывания и не поддерживается автоматической проверкой.');
        return compare(!!cell?.formula && normalizeFormula(cell.formula) === normalizeFormula(item.expected), cell?.formula ?? 'Нет формулы', item.expected);
      }
      if (cell?.value === null && (cell.formula || cell.formulaSupported === false)) return failure('В ячейке нет сохранённого результата формулы. Пересчёт формул не выполняется.');
      if (cell?.valueType === 'error') return compare(false, cell.value ?? 'Ошибка ячейки', item.expected);
      const actual = cell?.value ?? '';
      const matches = item.mode === 'number' ? cell?.valueType === 'number' && number(actual) !== null
        && Math.abs(number(actual) - number(item.expected)) <= item.tolerance
        : normalizeText(actual, item.caseSensitive) === normalizeText(item.expected, item.caseSensitive);
      return compare(matches, actual, item.expected);
    }
    if (item.kind === 'slideCount') return compare(document.slides.length === item.expected, document.slides.length, item.expected);
    const slide = document.slides[item.slide - 1];
    if (!slide) return compare(false, 'Слайд отсутствует', `Слайд ${item.slide}`);
    if (item.kind === 'imageCount') return compare(slide.images >= item.minimum, slide.images, `Не менее ${item.minimum}`);
    const actual = normalizeText(slide.text, item.caseSensitive), expected = normalizeText(item.expected, item.caseSensitive);
    return compare(item.comparison === 'exact' ? actual === expected : actual.includes(expected), slide.text, item.expected);
  });
  const correct = criteria.filter(item => item.status === 'correct').length;
  const errors = criteria.filter(item => item.status === 'error').length;
  return { status: errors ? 'error' : correct === criteria.length ? 'correct' : 'incorrect',
    message: `Выполнено критериев: ${correct} из ${criteria.length}.${errors ? ` Не удалось проверить: ${errors}.` : ''}`,
    format: document.format, criteria };
}
async function officeAssessment(data, checker) {
  const { inspectOffice } = require('./office-document.cjs');
  try { return assessOfficeDocument(await inspectOffice(data, checker.type, checker.criteria), checker); }
  catch (error) { if (error.name === 'OfficeError') check(false, error.message); throw error; }
}

module.exports = { OFFICE_LIMITS, validateOfficeChecker, normalizeFormula, assessOfficeDocument, officeAssessment };
