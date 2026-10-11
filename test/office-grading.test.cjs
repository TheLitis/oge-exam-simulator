'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateChecker } = require('../src/grading.cjs');
const { normalizeFormula, assessOfficeDocument } = require('../src/office-grading.cjs');
const table = criteria => ({ type: 'spreadsheet', criteria });
const deck = criteria => ({ type: 'presentation', criteria });
const cell = extra => ({ kind: 'cellValue', sheet: 'Лист1', cell: 'A1', mode: 'text', expected: 'Москва', ...extra });
const doc = { format: 'ods', sheets: [{ name: 'Лист1', charts: 1, cells: {
  A1: { value: 'Москва', valueType: 'text', formula: null }, B1: { value: '5', valueType: 'number', formula: 'of:=SUM([.B2:.C2])' },
  C1: { value: null, valueType: 'empty', formula: '=A1' }, D1: { value: '#DIV/0!', valueType: 'error', formula: '=1/0' },
  E1: { value: '5', valueType: 'text', formula: null }, F1: { value: '2', valueType: 'number', formula: null, formulaSupported: false },
} }, { name: 'Итоги', charts: 0, cells: {} }] };

test('Office criteria validate strictly, canonicalize addresses and remain optional', () => {
  assert.equal(validateChecker(13, null), null);
  assert.deepEqual(validateChecker(13, table([cell({ sheet: ' Лист1 ', cell: ' a1 ' })])).criteria[0],
    cell({ caseSensitive: true }));
  assert.deepEqual(validateChecker(16, deck([{ kind: 'slideText', slide: 1, expected: 'Текст' }])).criteria[0],
    { kind: 'slideText', slide: 1, expected: 'Текст', comparison: 'contains', caseSensitive: true });
  const invalid = [table([]), table(Array(33).fill(cell())), table([cell({ cell: 'A0' })]), table([cell({ cell: 'XFE1' })]),
    table([cell({ cell: 'A1048577' })]), table([cell({ cell: 'A1:B2' })]), table([cell({ sheet: '' })]),
    table([cell({ mode: 'number', expected: 'Infinity' })]), table([cell({ mode: 'number', expected: 'NaN' })]),
    table([cell({ mode: 'number', expected: '1e309' })]), table([cell({ mode: 'number', expected: '1 000' })]),
    table([cell({ mode: 'number', expected: '5', tolerance: -1 })]), table([cell({ mode: 'number', expected: '5', tolerance: NaN })]),
    table([cell({ formula: 'evil' })]), table([{ kind: 'cellFormula', sheet: 'Лист1', cell: 'A1', expected: '=' }]),
    table([{ kind: 'chartCount', sheet: 'Лист1', minimum: 0 }]), table([{ kind: 'sheetCount', expected: 257 }]),
    deck([{ kind: 'slideCount', expected: '2' }]), deck([{ kind: 'slideText', slide: 0, expected: 'Текст' }]),
    deck([{ kind: 'slideText', slide: 1, expected: ' ' }]), deck([{ kind: 'slideText', slide: 1, expected: 'Текст', comparison: 'regex' }]),
    deck([{ kind: 'imageCount', slide: 1, minimum: 0 }]), deck([cell()]), table([{ kind: 'slideCount', expected: 1 }]),
    table([cell({ expected: '\ud800' })]), table([cell({ expected: 'x'.repeat(4097) })]),
    table([cell({ expected: 'x\0' })]), table([cell({ caseSensitive: 1 })]), { ...table([cell()]), command: 'echo hi' }];
  for (const value of invalid) assert.throws(() => validateChecker(13, value), { name: 'UserError' });
  assert.throws(() => validateChecker(1, table([cell()])), { name: 'UserError' });
  assert.throws(() => validateChecker(13, table(Array(32).fill(cell({ expected: 'я'.repeat(4000) })))), { name: 'UserError' });
  assert.equal(validateChecker(13, table([cell({ cell: 'XFD1048576', mode: 'number', expected: '1,5' })])).criteria[0].tolerance, 0);
});

test('formula comparison bridges simple ODF/Excel syntax without changing literals or array dimensions', () => {
  assert.equal(normalizeFormula('of:=sum([.B2:.C2]; "A B")'), normalizeFormula('= SUM(B2:C2, "A B")'));
  assert.notEqual(normalizeFormula('="A B"'), normalizeFormula('="AB"'));
  assert.notEqual(normalizeFormula('="да"'), normalizeFormula('="ДА"'));
  assert.notEqual(normalizeFormula("='Лист 1'!A1"), normalizeFormula("='Лист1'!A1"));
  assert.notEqual(normalizeFormula('={1;2}'), normalizeFormula('={1,2}'));
  assert.notEqual(normalizeFormula('=A1'), normalizeFormula('=$A$1'));
  assert.notEqual(normalizeFormula('=SUM(Foo Bar)'), normalizeFormula('=SUM(FooBar)'));
  assert.notEqual(normalizeFormula('=A1 B1'), normalizeFormula('=A1B1'));
  assert.equal(normalizeFormula('=SUM( B2 : C2 , "A B" )'), normalizeFormula('=SUM(B2:C2,"A B")'));
});

test('spreadsheet grading distinguishes text/numbers, finite tolerance, blank cells, missing sheets and cached results', () => {
  const run = item => assessOfficeDocument(doc, validateChecker(13, table([item])));
  assert.equal(run(cell()).status, 'correct');
  assert.equal(run(cell({ expected: 'москва' })).status, 'incorrect');
  assert.equal(run(cell({ expected: 'москва', caseSensitive: false })).status, 'correct');
  assert.equal(run(cell({ cell: 'B1', mode: 'number', expected: '5,01', tolerance: 0.02 })).status, 'correct');
  assert.equal(run(cell({ cell: 'B1', mode: 'number', expected: '5.01', tolerance: 0 })).status, 'incorrect');
  assert.equal(run(cell({ cell: 'E1', mode: 'number', expected: '5' })).status, 'incorrect');
  assert.equal(run(cell({ cell: 'G1', expected: '' })).status, 'correct');
  assert.equal(run(cell({ cell: 'G1', mode: 'number', expected: '0' })).status, 'incorrect');
  assert.equal(run(cell({ cell: 'C1', expected: '' })).status, 'error');
  assert.equal(run(cell({ cell: 'D1', expected: '#DIV/0!' })).status, 'incorrect');
  assert.equal(run(cell({ sheet: 'лист1' })).status, 'incorrect');
  assert.equal(run({ kind: 'cellFormula', sheet: 'Лист1', cell: 'B1', expected: '=SUM(B2:C2)' }).status, 'correct');
  assert.equal(run({ kind: 'cellFormula', sheet: 'Лист1', cell: 'F1', expected: '=A1' }).status, 'error');
  const mixed = assessOfficeDocument(doc, validateChecker(13, table([cell(), { kind: 'sheetCount', expected: 2 },
    { kind: 'sheetExists', sheet: 'Итоги' }, { kind: 'chartCount', sheet: 'Лист1', minimum: 2 }])));
  assert.equal(mixed.status, 'incorrect'); assert.deepEqual(mixed.criteria.map(c => c.status), ['correct', 'correct', 'correct', 'incorrect']);
  assert.match(mixed.message, /3 из 4/); assert.equal(mixed.criteria[3].actual, '1');
  const unknown = assessOfficeDocument(doc, validateChecker(13, table([cell(), cell({ cell: 'C1', expected: '42' })])));
  assert.equal(unknown.status, 'error'); assert.equal(unknown.criteria[0].status, 'correct');
});

test('presentation grading checks each ordered slide and exact/contains text, with bounded report text', () => {
  const document = { format: 'pptx', slides: [{ text: 'План занятия\nТема: таблицы', images: 1 }, { text: 'Итоги', images: 0 }] };
  const result = assessOfficeDocument(document, validateChecker(14, deck([{ kind: 'slideCount', expected: 2 },
    { kind: 'slideText', slide: 1, expected: 'план занятия', caseSensitive: false },
    { kind: 'slideText', slide: 2, expected: 'Итоги', comparison: 'exact' }, { kind: 'imageCount', slide: 1, minimum: 1 }])));
  assert.equal(result.status, 'correct'); assert.equal(result.format, 'pptx');
  const failed = assessOfficeDocument(document, validateChecker(14, deck([{ kind: 'slideText', slide: 1, expected: 'План занятия', comparison: 'exact' },
    { kind: 'imageCount', slide: 2, minimum: 1 }, { kind: 'slideText', slide: 3, expected: 'Итоги' }])));
  assert.equal(failed.status, 'incorrect'); assert.equal(failed.criteria.length, 3);
  document.slides[0].text = 'x'.repeat(10000);
  assert.equal(assessOfficeDocument(document, validateChecker(14, deck([{ kind: 'slideText', slide: 1, expected: 'x' }]))).criteria[0].actual.length, 4096);
});
