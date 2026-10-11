'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectOffice, LIMITS } = require('../src/office-document.cjs');
const { pack, odfParts, ods, odp, xlsxParts, xlsx, pptxParts, pptx, relationships, O, X } = require('./helpers/office-fixtures.cjs');
const cell = (sheet, address) => ({ kind: 'cellValue', sheet, cell: address });
const reject = (data, type = 'spreadsheet', criteria = []) => assert.rejects(inspectOffice(data, type, criteria), { name: 'OfficeError' });

test('ODS values and formulas are read by namespace URI, with ODF spaces and paragraphs', async () => {
  const data = await ods('<table:table table:name="Лист1"><table:table-row><table:table-cell office:value-type="float" office:value="42" table:formula="of:=SUM([.B1:.B2])"/><table:table-cell office:value-type="string"><text:p>А<text:s text:c="2"/>Б<text:tab/>В<text:line-break/>Г</text:p><text:p>Д</text:p></table:table-cell><table:table-cell office:value-type="boolean" office:boolean-value="true"/></table:table-row></table:table>');
  const original = Buffer.from(data);
  const result = await inspectOffice(data, 'spreadsheet', [cell('Лист1', 'A1'), cell('Лист1', 'B1'), cell('Лист1', 'C1'), cell('Лист1', 'D1')]);
  assert.equal(result.format, 'ods'); assert.equal(result.sheets.length, 1);
  assert.deepEqual(result.sheets[0].cells.A1, { value: '42', valueType: 'number', formula: 'of:=SUM([.B1:.B2])' });
  assert.equal(result.sheets[0].cells.B1.value, 'А  Б\tВ\nГ\nД');
  assert.equal(result.sheets[0].cells.C1.value, 'true');
  assert.deepEqual(result.sheets[0].cells.D1, { value: null, valueType: 'empty', formula: null });
  assert.deepEqual(data, original, 'worker transfer must not detach or mutate submitted data');
  const parts = odfParts('spreadsheet', '<table:table table:name="Новый"><table:table-row><table:table-cell office:value-type="float" office:value="3"/></table:table-row></table:table>');
  parts['content.xml'] = parts['content.xml'].replace(/(<\/?| )table:/g, '$1q:').replace('xmlns:table=', 'xmlns:q=');
  const renamed = await inspectOffice(await pack(parts), 'spreadsheet', [cell('Новый', 'A1')]);
  assert.equal(renamed.sheets[0].cells.A1.value, '3');
});

test('ODS repeated rows and columns remain sparse, and dependent repeated formulas are explicit', async () => {
  const data = await ods('<table:table table:name="Лист"><table:table-row table:number-rows-repeated="1000000000"><table:table-cell table:number-columns-repeated="1000000000" office:value-type="float" office:value="7" table:formula="of:=[.B1]"/></table:table-row></table:table>');
  const result = await inspectOffice(data, 'spreadsheet', [cell('Лист', 'A1'), cell('Лист', 'XFD1048576')]);
  assert.equal(Object.keys(result.sheets[0].cells).length, 2);
  assert.equal(result.sheets[0].cells.XFD1048576.value, '7');
  assert.equal(result.sheets[0].cells.A1.formulaSupported, undefined);
  assert.equal(result.sheets[0].cells.XFD1048576.formulaSupported, false);
});

test('ODS ignores nested tables as sheets and counts only linked chart objects', async () => {
  const chart = `<office:document-content xmlns:office="${O}office:1.0" xmlns:chart="${O}chart:1.0"><office:body><office:chart><chart:chart/></office:chart></office:body></office:document-content>`;
  const data = await ods('<table:table table:name="Основной"><table:table-row><table:table-cell office:value-type="string"><text:p>наружный</text:p><table:table table:name="Вложенный"><table:table-row><table:table-cell><text:p>чужой</text:p></table:table-cell></table:table-row></table:table></table:table-cell><table:table-cell office:value-type="float" office:value="2"/></table:table-row><table:shapes><draw:frame><draw:object xlink:href="./Object 1"/></draw:frame><draw:frame><draw:object xlink:href="Object 2"/></draw:frame><draw:object xlink:href="https://example.invalid/chart"/></table:shapes></table:table>', { 'Object 1/content.xml': chart, 'Object 2/content.xml': '<notChart/>' });
  const r = await inspectOffice(data, 'spreadsheet', [cell('Основной', 'A1'), cell('Основной', 'B1')]);
  assert.equal(r.sheets.length, 1); assert.equal(r.sheets[0].charts, 1);
  assert.equal(r.sheets[0].cells.A1.value, 'наружный'); assert.equal(r.sheets[0].cells.B1.value, '2');
});

test('ODP text excludes notes and masters; image representations in one frame count once', async () => {
  const data = await odp('<draw:page><draw:frame><draw:text-box><text:p>Первый <text:span>слайд</text:span></text:p></draw:text-box></draw:frame><draw:frame><draw:image xlink:href="Pictures/a.png"/><draw:image xlink:href="Pictures/b.png"/></draw:frame><draw:frame><draw:image xlink:href="https://example.invalid/a.png"/></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Секрет заметки</text:p></draw:text-box><draw:image xlink:href="Pictures/a.png"/></draw:frame></presentation:notes></draw:page><draw:page><draw:frame><draw:text-box><text:p>Второй</text:p></draw:text-box></draw:frame></draw:page>', { 'Pictures/a.png': Buffer.from([137,80,78,71]), 'Pictures/b.png': Buffer.from([137,80,78,71]), 'styles.xml': '<text:p>Образец</text:p>' });
  const r = await inspectOffice(data, 'presentation');
  assert.deepEqual(r, { format: 'odp', slides: [{ text: 'Первый слайд', images: 1 }, { text: 'Второй', images: 0 }] });
});

test('XLSX uses workbook relationship order, shared/inline strings and cached values', async () => {
  const data = await xlsx([{ name: 'Последний', file: 'worksheets/sheet9.xml', rows: '<row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>42</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><r><t>inline </t></r><r><t>строка</t></r><rPh><t>phonetic</t></rPh></is></c><c r="D1" t="b"><v>0</v></c><c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1" t="d"><v>2026-10-11</v></c></row>' }, { name: 'Первый', file: 'worksheets/sheet1.xml' }]);
  const r = await inspectOffice(data, 'spreadsheet', ['A1','B1','C1','D1','E1','F1'].map(a => cell('Последний', a)));
  assert.deepEqual(r.sheets.map(s => s.name), ['Последний', 'Первый']);
  assert.deepEqual(r.sheets[0].cells.A1, { value: '42', valueType: 'number', formula: 'SUM(B1:B2)' });
  assert.equal(r.sheets[0].cells.B1.value, 'Привет'); assert.equal(r.sheets[0].cells.C1.value, 'inline строка');
  assert.equal(r.sheets[0].cells.D1.value, 'false'); assert.equal(r.sheets[0].cells.E1.valueType, 'error'); assert.equal(r.sheets[0].cells.F1.valueType, 'date');
});

test('XLSX shared dependent formulas are unavailable, with missing caches kept null', async () => {
  const data = await xlsx([{ name: 'Лист', rows: '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A3">B1*2</f><v>4</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>6</v></c></row><row r="3"><c r="A3"><f>B3*2</f></c></row><row r="4"><c r="A4"><f t="array" ref="A4:A5">B4:B5*2</f><v>10</v></c></row>' }]);
  const r = await inspectOffice(data, 'spreadsheet', ['A1','A2','A3','A4'].map(a => cell('Лист', a)));
  assert.equal(r.sheets[0].cells.A1.formula, 'B1*2'); assert.equal(r.sheets[0].cells.A2.formulaSupported, false);
  assert.equal(r.sheets[0].cells.A3.value, null); assert.equal(r.sheets[0].cells.A3.formula, 'B3*2'); assert.equal(r.sheets[0].cells.A4.formulaSupported, false);
});

test('XLSX optional row and cell addresses are inferred without shifting explicit gaps', async () => {
  const data = await xlsx([{ name: 'Лист', rows: '<row><c><v>1</v></c><c r="C1"><v>3</v></c><c><v>4</v></c></row><row><c><v>5</v></c></row><row r="5"><c><v>9</v></c></row>' }]);
  const result = await inspectOffice(data, 'spreadsheet', ['A1','B1','C1','D1','A2','A5'].map(a => cell('Лист', a)));
  assert.deepEqual(Object.fromEntries(Object.entries(result.sheets[0].cells).map(([k,v]) => [k,v.value])), { A1:'1',B1:null,C1:'3',D1:'4',A2:'5',A5:'9' });
});

test('LibreOffice explicit error values stay errors, without inferring errors from literal text', async () => {
  const parts = odfParts('spreadsheet', '<table:table table:name="Лист"><table:table-row><table:table-cell office:value-type="string" calcext:value-type="error" table:formula="of:=1/0"><text:p>#DIV/0!</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>#DIV/0!</text:p></table:table-cell></table:table-row></table:table>');
  parts['content.xml'] = parts['content.xml'].replace('<office:document-content ', '<office:document-content xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" ');
  const r = await inspectOffice(await pack(parts), 'spreadsheet', [cell('Лист', 'A1'), cell('Лист', 'B1')]);
  assert.equal(r.sheets[0].cells.A1.valueType, 'error'); assert.equal(r.sheets[0].cells.A1.value, '#DIV/0!'); assert.equal(r.sheets[0].cells.B1.valueType, 'text');
});

test('Strict Open XML namespace documents and UTF-16 ODF XML are accepted', async () => {
  const parts = xlsxParts([{ name: 'Лист', rows: '<row r="1"><c r="A1"><f>B1*2</f><v>42</v></c></row>' }]);
  for (const key of Object.keys(parts)) {
    parts[key] = parts[key].replaceAll(`${X}spreadsheetml/2006/main`, 'http://purl.oclc.org/ooxml/spreadsheetml/main')
      .replaceAll(`${X}officeDocument/2006/relationships`, 'http://purl.oclc.org/ooxml/officeDocument/relationships');
  }
  assert.equal((await inspectOffice(await pack(parts), 'spreadsheet', [cell('Лист', 'A1')])).sheets[0].cells.A1.value, '42');
  const odf = odfParts('presentation', '<draw:page><draw:frame><draw:text-box><text:p>UTF-16 слайд</text:p></draw:text-box></draw:frame></draw:page>');
  odf['content.xml'] = Buffer.concat([Buffer.from([255,254]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + odf['content.xml'], 'utf16le')]);
  assert.equal((await inspectOffice(await pack(odf), 'presentation')).slides[0].text, 'UTF-16 слайд');
});

test('Streamed ZIP descriptors are checked and corrupt descriptors rejected', async () => {
  const data = await pack(odfParts('spreadsheet', '<table:table table:name="Лист"/>'), { streamFiles: true });
  assert.equal((await inspectOffice(data, 'spreadsheet')).sheets[0].name, 'Лист');
  const bad = Buffer.from(data), descriptor = bad.indexOf(Buffer.from([0x50,0x4b,0x07,0x08]));
  assert.ok(descriptor > 0); bad[descriptor + 4] ^= 1; await reject(bad);
});

test('XLSX chart count follows actual drawing and chart relationships', async () => {
  const data = await xlsx([{ name: 'Лист', after: '<drawing r:id="draw"/>' }], {
    'xl/worksheets/_rels/sheet1.xml.rels': relationships([['draw', 'drawing', '../drawings/drawing1.xml']]),
    'xl/drawings/drawing1.xml': `<drawing xmlns:c="${X}drawingml/2006/chart" xmlns:r="${X}officeDocument/2006/relationships"><c:chart r:id="chart"/><c:chart r:id="external"/></drawing>`,
    'xl/drawings/_rels/drawing1.xml.rels': relationships([['chart', 'chart', '../charts/chart1.xml'], ['external', 'chart', 'https://example.invalid/chart.xml', true]]),
    'xl/charts/chart1.xml': `<c:chartSpace xmlns:c="${X}drawingml/2006/chart"><c:chart/></c:chartSpace>`,
    'xl/charts/chart99.xml': `<c:chartSpace xmlns:c="${X}drawingml/2006/chart"><c:chart/></c:chartSpace>`,
  });
  assert.equal((await inspectOffice(data, 'spreadsheet')).sheets[0].charts, 1);
});

test('PPTX slide relationship order includes hidden slides, pictures exclude external or missing parts', async () => {
  const data = await pptx([{ file: 'slide8.xml', text: 'Восьмой', hidden: true }, { file: 'slide1.xml', body: '<p:sp><p:txBody><a:p><a:r><a:t>Первый</a:t></a:r><a:br/><a:r><a:t>Текст</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic><p:pic><p:blipFill><a:blip r:link="external"/></p:blipFill></p:pic><p:pic><p:blipFill><a:blip r:embed="missing"/></p:blipFill></p:pic><p:sp><p:nvSpPr><p:cNvPr id="50" name="hidden" hidden="true"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Скрытый текст</a:t></a:r></a:p></p:txBody></p:sp>', rels: [['image', 'image', '../media/a.png'], ['external', 'image', 'https://example.invalid/a.png', true], ['missing', 'image', '../media/missing.png']] }], { 'ppt/media/a.png': Buffer.from([137,80,78,71]), 'ppt/slides/slide99.xml': '<unused/>', 'ppt/notesSlides/notesSlide1.xml': '<notes>заметка</notes>' });
  const r = await inspectOffice(data, 'presentation');
  assert.deepEqual(r, { format: 'pptx', slides: [{ text: 'Восьмой', images: 0 }, { text: 'Первый\nТекст', images: 1 }] });
});

test('PPTX explicitly hidden groups hide their child text and pictures', async () => {
  const data = await pptx([{ body: '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="1" name="group" hidden="1"/></p:nvGrpSpPr><p:sp><p:txBody><a:p><a:r><a:t>Скрытый</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic></p:grpSp><p:sp><p:txBody><a:p><a:r><a:t>Видимый</a:t></a:r></a:p></p:txBody></p:sp>', rels: [['image', 'image', '../media/a.png']] }], { 'ppt/media/a.png': Buffer.from([137,80,78,71]) });
  assert.deepEqual((await inspectOffice(data, 'presentation')).slides, [{ text: 'Видимый', images: 0 }]);
});

test('Linked image parts must have valid ZIP data and CRC, without extracting files', async () => {
  const parts = pptxParts([{ body: '<p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic>', rels: [['image', 'image', '../media/a.png']] }], { 'ppt/media/a.png': Buffer.from('IMAGE-CHECKSUM-PROBE') });
  const data = await pack(parts, { compression: 'STORE' }), bad = Buffer.from(data);
  const pos = bad.indexOf(Buffer.from('IMAGE-CHECKSUM-PROBE')); assert.ok(pos > 0); bad[pos] ^= 1;
  await reject(bad, 'presentation');
});

test('Office families and macro/encrypted packages fail closed', async () => {
  await reject(await ods('<table:table table:name="Лист"/>'), 'presentation');
  await reject(await pptx([{ text: 'текст' }]), 'spreadsheet');
  await reject(Buffer.from('not a zip'));
  await reject(await ods('', { 'Basic/Standard/Module1.xml': '<macro/>' }));
  await reject(await ods('', { 'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="${O}manifest:1.0"><manifest:encryption-data/></manifest:manifest>` }));
  await reject(await xlsx([{ name: 'Лист' }], { 'xl/vbaProject.bin': 'macro' }));
  await reject(await xlsx([{ name: 'Лист' }], { '[Content_Types].xml': `<Types xmlns="${X}package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>` }));
});

test('Namespace confusion, malformed XML, DTD and entity expansion are rejected', async () => {
  await reject(await ods('', { 'content.xml': '<!DOCTYPE x [<!ENTITY a "SECRET">]><x>&a;</x>' }));
  await reject(await ods('', { 'content.xml': '<office:document-content xmlns:office="evil"><office:body><office:spreadsheet/></office:body></office:document-content>' }));
  await reject(await ods('', { 'content.xml': '<broken><unclosed></broken>' }));
  await reject(await ods('', { 'content.xml': `<office:document-content xmlns:office="${O}office:1.0"><office:body><office:spreadsheet>&custom;</office:spreadsheet></office:body></office:document-content>` }));
});

test('Unsafe ZIP names, duplicate names, symlinks, encryption and local header mismatch are rejected', async () => {
  for (const name of ['../evil', '/absolute', 'a\\evil', 'a/./evil']) await reject(await ods('', { [name]: 'x' }));
  await reject(await ods('', { 'CONTENT.XML': '<duplicate/>' }));
  const data = await ods('');
  let central = data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  let bad = Buffer.from(data); bad.writeUInt32LE(0xa000 << 16 >>> 0, central + 38); await reject(bad);
  bad = Buffer.from(data); bad.writeUInt16LE(1, central + 8); await reject(bad);
  bad = Buffer.from(data); bad[30] ^= 1; await reject(bad);
});

test('CRC corruption and forged inflated sizes cannot produce valid results', async () => {
  const data = await pack(odfParts('spreadsheet', '<table:table table:name="Лист"/>'), { compression: 'STORE' });
  let bad = Buffer.from(data); const needle = Buffer.from('application/vnd.oasis.opendocument.spreadsheet'); bad[bad.indexOf(needle)] ^= 1; await reject(bad);
  bad = Buffer.from(data); const central = bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  const local = bad.readUInt32LE(central + 42); bad.writeUInt32LE(1, central + 24); bad.writeUInt32LE(1, local + 22); await reject(bad);
  const compressed = await ods(''); bad = Buffer.from(compressed); const c = bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  const l = bad.readUInt32LE(c + 42); bad.writeUInt32LE(1, c + 24); bad.writeUInt32LE(1, l + 22); await reject(bad);
});

test('Document structure and XML text limits are bounded', async () => {
  await reject(Buffer.alloc(LIMITS.archive + 1));
  await reject(await ods('', { 'content.xml': '<a>'.repeat(65) + '</a>'.repeat(65) }));
  const longText = 'А'.repeat(LIMITS.text / 2 + 1);
  await reject(await odp(`<draw:page><draw:frame><draw:text-box><text:p>${longText}</text:p></draw:text-box></draw:frame></draw:page>`), 'presentation');
  await reject(await ods(Array.from({ length: 257 }, (_, i) => `<table:table table:name="Лист${i}"/>`).join('')));
  await reject(await odp('<draw:page/>'.repeat(257)), 'presentation');
  const parts = odfParts('spreadsheet', ''); for (let i = 0; i < 2001; i++) parts[`part${i}`] = ''; await reject(await pack(parts));
});
