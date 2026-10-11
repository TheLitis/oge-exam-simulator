'use strict';
// Read-only inspection in a disposable worker. No Office program is launched,
// formulas are never evaluated, and neither ZIP entries nor links touch disk.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { createInflateRaw } = require('node:zlib');
const { Readable } = require('node:stream');
const path = require('node:path').posix;
const { SaxesParser } = require('../vendor/saxes.cjs');
const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ archive: 32 * MiB, expanded: 128 * MiB, entries: 2000,
  xmlPart: 8 * MiB, xmlTotal: 64 * MiB, text: MiB, nodes: 500000, depth: 64,
  sheets: 256, slides: 256, criteria: 256, wallMs: 8000 });
class OfficeError extends Error {
  constructor(message) { super(message); this.name = 'OfficeError'; }
}
const check = (yes, message) => { if (!yes) throw new OfficeError(message); };
const NS = Object.freeze({
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentationODF: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  chartODF: 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  calcext: 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
  sheet: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  packageRel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
});
const STRICT = new Map([
  [NS.sheet, 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
  [NS.presentation, 'http://purl.oclc.org/ooxml/presentationml/main'],
  [NS.drawing, 'http://purl.oclc.org/ooxml/drawingml/main'],
  [NS.chart, 'http://purl.oclc.org/ooxml/drawingml/chart'],
  [NS.rel, 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
]);
function is(node, ns, local) { return node && node.local === local && (node.uri === NS[ns] || node.uri === STRICT.get(NS[ns])); }
function attr(node, ns, local) {
  for (const a of Object.values(node.attributes)) {
    if (a.local === local && (ns ? (a.uri === NS[ns] || a.uri === STRICT.get(NS[ns])) : a.uri === '')) return a.value;
  }
  return undefined;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});
function crcStep(crc, data) { for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return crc; }
function decodeUtf8(data) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new OfficeError('В документе есть некорректный текст UTF-8.'); }
}
function safeZipName(name) {
  check(name.length > 0 && name.length <= 1024 && !/[\\\x00-\x1f\x7f:]/u.test(name) && !name.startsWith('/'), 'Недопустимый путь внутри документа.');
  const parts = name.replace(/\/$/, '').split('/');
  check(parts.every(p => p && p !== '.' && p !== '..'), 'Недопустимый путь внутри документа.');
  return name;
}
function zipExtras(buf, start, end) {
  while (start < end) {
    check(start + 4 <= end, 'Повреждён дополнительный заголовок ZIP.');
    const id = buf.readUInt16LE(start), size = buf.readUInt16LE(start + 2);
    check(id !== 1 && start + 4 + size <= end, 'ZIP64 и повреждённые заголовки не поддерживаются.');
    start += 4 + size;
  }
}
function inspectZip(data) {
  check(data.length >= 22 && data.length <= LIMITS.archive && data.readUInt32LE(0) === 0x04034b50, 'Нужен документ ODS, XLSX, ODP или PPTX размером до 32 МБ.');
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) {
    if (data.readUInt32LE(p) === 0x06054b50 && p + 22 + data.readUInt16LE(p + 20) === data.length) { end = p; break; }
  }
  check(end >= 0, 'Повреждён каталог ZIP документа.');
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), size = data.readUInt32LE(end + 12);
  check(count > 0 && count <= LIMITS.entries && count !== 65535 && start !== 0xffffffff && size !== 0xffffffff && start + size === end,
    'Некорректный каталог ZIP или превышено ограничение числа файлов.');
  check(data.readUInt16LE(end + 4) === 0 && data.readUInt16LE(end + 6) === 0 && data.readUInt16LE(end + 8) === count,
    'Многотомные ZIP не поддерживаются.');
  let p = start, expanded = 0;
  const entries = new Map(), seen = new Set(), ranges = [];
  for (let i = 0; i < count; i++) {
    check(p + 46 <= end && data.readUInt32LE(p) === 0x02014b50, 'Повреждён каталог ZIP документа.');
    const flags = data.readUInt16LE(p + 8), method = data.readUInt16LE(p + 10), crc = data.readUInt32LE(p + 16),
      compressed = data.readUInt32LE(p + 20), length = data.readUInt32LE(p + 24),
      nl = data.readUInt16LE(p + 28), el = data.readUInt16LE(p + 30), cl = data.readUInt16LE(p + 32),
      local = data.readUInt32LE(p + 42), mode = (data.readUInt32LE(p + 38) >>> 16) & 0xf000;
    check(p + 46 + nl + el + cl <= end && nl > 0 && (flags & ~0x080e) === 0 && [0, 8].includes(method),
      'Зашифрованные ZIP и неподдерживаемое сжатие не допускаются.');
    check(data.readUInt16LE(p + 34) === 0 && (method !== 0 || (flags & 6) === 0), 'Некорректный формат ZIP документа.');
    const name = safeZipName(decodeUtf8(data.subarray(p + 46, p + 46 + nl))), key = name.toLowerCase();
    check(!seen.has(key), 'В документе повторяются имена частей.'); seen.add(key);
    check(mode === 0 || mode === 0x8000 || (mode === 0x4000 && name.endsWith('/')), 'Ссылки и специальные файлы внутри документа запрещены.');
    check(compressed !== 0xffffffff && length !== 0xffffffff && local !== 0xffffffff && length <= LIMITS.expanded && compressed <= LIMITS.archive,
      'ZIP64 и слишком большие части не поддерживаются.');
    expanded += length; check(expanded <= LIMITS.expanded, 'Распакованный документ больше 128 МБ.');
    zipExtras(data, p + 46 + nl, p + 46 + nl + el);
    check(local + 30 <= start && data.readUInt32LE(local) === 0x04034b50, 'Повреждён локальный заголовок ZIP.');
    const ln = data.readUInt16LE(local + 26), le = data.readUInt16LE(local + 28), body = local + 30 + ln + le;
    check(body + compressed <= start && data.readUInt16LE(local + 6) === flags && data.readUInt16LE(local + 8) === method &&
      data.subarray(local + 30, local + 30 + ln).equals(data.subarray(p + 46, p + 46 + nl)), 'Заголовки частей ZIP не совпадают.');
    zipExtras(data, local + 30 + ln, body);
    let dataEnd = body + compressed;
    if (flags & 8) {
      check([0, crc].includes(data.readUInt32LE(local + 14)) && [0, compressed].includes(data.readUInt32LE(local + 18)) &&
        [0, length].includes(data.readUInt32LE(local + 22)), 'Локальные размеры ZIP не совпадают с каталогом.');
      if (dataEnd + 4 <= start && data.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      check(dataEnd + 12 <= start && data.readUInt32LE(dataEnd) === crc && data.readUInt32LE(dataEnd + 4) === compressed &&
        data.readUInt32LE(dataEnd + 8) === length, 'Повреждён дескриптор данных ZIP.');
      dataEnd += 12;
    } else check(data.readUInt32LE(local + 14) === crc && data.readUInt32LE(local + 18) === compressed && data.readUInt32LE(local + 22) === length,
      'Размеры или контрольные суммы ZIP не совпадают.');
    check(method !== 0 || compressed === length, 'Некорректный размер несжатой части ZIP.');
    ranges.push({ start: local, end: dataEnd });
    if (!name.endsWith('/')) entries.set(name, { name, body, compressed, length, method, crc });
    p += 46 + nl + el + cl;
  }
  check(p === end, 'Повреждён каталог ZIP документа.');
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) check(ranges[i].start >= ranges[i - 1].end, 'Части ZIP перекрываются.');
  for (const name of entries.keys()) check(!/(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|Basic|Scripts|activeX)(?:\/|$)/i.test(name), 'Документы с макросами не поддерживаются.');
  return entries;
}
class Document {
  constructor(data) { this.data = data; this.entries = inspectZip(data); this.xmlBytes = 0; this.nodes = 0; this.textBytes = 0; this.verified = new Set(); }
  has(name) { return this.entries.has(name); }
  addText(text) { this.textBytes += Buffer.byteLength(text); check(this.textBytes <= LIMITS.text, 'Текст документа превышает ограничение 1 МБ.'); return text; }
  async read(name, max = LIMITS.xmlPart) {
    const e = this.entries.get(name); check(e && e.length <= max, 'В документе нет нужной части или она слишком велика.');
    const compressed = this.data.subarray(e.body, e.body + e.compressed);
    let length = 0, crc = 0xffffffff; const chunks = [];
    if (e.method === 0) { length = compressed.length; crc = crcStep(crc, compressed); chunks.push(compressed); }
    else {
      const inflater = createInflateRaw();
      try {
        Readable.from([compressed]).pipe(inflater);
        for await (const chunk of inflater) {
          length += chunk.length; check(length <= e.length && length <= max, 'Реальный размер части ZIP больше заявленного.');
          crc = crcStep(crc, chunk); chunks.push(chunk);
        }
        check(inflater.bytesWritten === e.compressed, 'Сжатая часть ZIP содержит лишние данные.');
      } catch (e) { inflater.destroy(); if (e instanceof OfficeError) throw e; throw new OfficeError('Повреждены сжатые данные документа.'); }
    }
    check(length === e.length && ((crc ^ 0xffffffff) >>> 0) === e.crc, 'Размер или контрольная сумма части ZIP неверны.');
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }
  async verifyPart(name) {
    if (this.verified.has(name)) return;
    const e = this.entries.get(name); check(e, 'В документе отсутствует изображение.');
    const data = this.data.subarray(e.body, e.body + e.compressed); let length = 0, crc = 0xffffffff;
    if (e.method === 0) { length = data.length; crc = crcStep(crc, data); }
    else {
      const inflater = createInflateRaw();
      try {
        Readable.from([data]).pipe(inflater);
        for await (const chunk of inflater) {
          length += chunk.length; check(length <= e.length, 'Реальный размер изображения больше заявленного.'); crc = crcStep(crc, chunk);
        }
        check(inflater.bytesWritten === e.compressed, 'Сжатая часть изображения содержит лишние данные.');
      } catch (e) { inflater.destroy(); if (e instanceof OfficeError) throw e; throw new OfficeError('Повреждены сжатые данные изображения.'); }
    }
    check(length === e.length && ((crc ^ 0xffffffff) >>> 0) === e.crc, 'Размер или контрольная сумма изображения неверны.');
    this.verified.add(name);
  }
  async xml(name, events = {}) {
    const data = await this.read(name);
    this.xmlBytes += data.length; check(this.xmlBytes <= LIMITS.xmlTotal, 'Общий размер XML документа больше 64 МБ.');
    let text;
    try {
      const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch { throw new OfficeError('Некорректная кодировка XML документа.'); }
    check(!/<!DOCTYPE|<!ENTITY/i.test(text), 'DTD и пользовательские XML-сущности запрещены.');
    const parser = new SaxesParser({ xmlns: true, position: false }), stack = [];
    parser.on('doctype', () => { throw new OfficeError('DTD запрещён.'); });
    parser.on('error', () => { throw new OfficeError('Повреждён XML документа.'); });
    parser.on('opentag', node => {
      this.nodes++; check(this.nodes <= LIMITS.nodes && stack.length < LIMITS.depth, 'XML документа слишком сложен.');
      stack.push(node); events.open?.(node, stack);
    });
    parser.on('closetag', node => { events.close?.(node, stack); stack.pop(); });
    parser.on('text', text => events.text?.(text, stack));
    parser.on('cdata', text => events.text?.(text, stack));
    parser.write(text).close();
  }
}
function resolvePart(base, value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f\x7f?#]/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('//')) return null;
  let decoded; try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\\\x00-\x1f\x7f?#:]/u.test(decoded) || decoded.startsWith('//')) return null;
  const result = decoded.startsWith('/') ? path.normalize(decoded.slice(1)) : path.normalize(path.join(path.dirname(base), decoded));
  if (!result || result === '.' || result === '..' || result.startsWith('../') || result.startsWith('/')) return null;
  try { return safeZipName(result); } catch { return null; }
}
const relKind = (type, kind) => type === `${NS.rel}/${kind}` || type === `${STRICT.get(NS.rel)}/${kind}`;
async function relationships(doc, part) {
  const file = part ? path.join(path.dirname(part), '_rels', path.basename(part) + '.rels') : '_rels/.rels';
  const result = new Map(); if (!doc.has(file)) return result;
  await doc.xml(file, { open(node, stack) {
    if (stack.length === 1) check(is(node, 'packageRel', 'Relationships'), 'Некорректные связи документа.');
    if (stack.length === 2 && is(node, 'packageRel', 'Relationship')) {
      const id = attr(node, null, 'Id'), type = attr(node, null, 'Type'), target = attr(node, null, 'Target'), mode = attr(node, null, 'TargetMode');
      check(id && type && target && !result.has(id) && (mode === undefined || mode === 'Internal' || mode === 'External'), 'Некорректная связь части документа.');
      result.set(id, { type, file: mode === 'External' ? null : resolvePart(part || '_root', target) });
    }
  }});
  return result;
}
function targetCells(criteria) {
  const result = new Map();
  for (const c of criteria) {
    if (!c || !['cellValue', 'cellFormula'].includes(c.kind)) continue;
    check(typeof c.sheet === 'string' && c.sheet.length <= 180 && typeof c.cell === 'string', 'Некорректный адрес проверяемой ячейки.');
    const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(c.cell.toUpperCase()); check(m, 'Некорректный адрес проверяемой ячейки.');
    let column = 0; for (const char of m[1]) column = column * 26 + char.charCodeAt(0) - 64;
    const row = Number(m[2]); check(column <= 16384 && row <= 1048576, 'Адрес ячейки выходит за поддерживаемый диапазон.');
    if (!result.has(c.sheet)) result.set(c.sheet, new Map());
    result.get(c.sheet).set(m[0], { address: m[0], row, column });
  }
  return result;
}
const emptyCell = () => ({ value: null, valueType: 'empty', formula: null });
function cellsFor(targets, name) { return Object.fromEntries(Array.from(targets.get(name)?.keys() || [], address => [address, emptyCell()])); }
function repeat(node, ns, local) {
  const raw = attr(node, ns, local); if (raw === undefined) return 1;
  check(/^[1-9][0-9]{0,15}$/.test(raw), 'Некорректное повторение строк или столбцов.');
  const value = Number(raw); check(Number.isSafeInteger(value), 'Слишком большое повторение строк или столбцов.'); return value;
}
function numeric(raw) { return typeof raw === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)); }
function columnNumber(letters) { let value = 0; for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64; return value; }
function columnLetters(number) {
  let result = ''; while (number) { number--; result = String.fromCharCode(65 + number % 26) + result; number = Math.floor(number / 26); }
  return result;
}
function boundedText(doc, current, value) { return current + doc.addText(value); }
function odfValue(node, text) {
  const type = attr(node, 'office', 'value-type'), formula = attr(node, 'table', 'formula') ?? null;
  const result = { value: null, valueType: 'empty', formula };
  if (attr(node, 'calcext', 'value-type') === 'error') {
    result.value = attr(node, 'office', 'string-value') ?? (text || null);
    result.valueType = 'error'; return result;
  }
  if (['float', 'currency', 'percentage'].includes(type)) {
    const raw = attr(node, 'office', 'value'); if (raw !== undefined) { check(numeric(raw), 'Некорректное числовое значение ячейки.'); result.value = raw; result.valueType = 'number'; }
  } else if (type === 'boolean') {
    const raw = attr(node, 'office', 'boolean-value'); if (raw !== undefined) { check(['true', 'false'].includes(raw), 'Некорректное логическое значение ячейки.'); result.value = raw; result.valueType = 'boolean'; }
  } else if (type === 'date' || type === 'time') {
    result.value = attr(node, 'office', type === 'date' ? 'date-value' : 'time-value') ?? null; result.valueType = result.value === null ? 'empty' : 'date';
  } else if (type === 'string' || text) { result.value = attr(node, 'office', 'string-value') ?? text; result.valueType = 'text'; }
  return result;
}
function odfTextOpen(doc, node, capture) {
  if (is(node, 'text', 'p') || is(node, 'text', 'h')) { if (capture.paragraphs++) capture.text = boundedText(doc, capture.text, '\n'); capture.inParagraph++; }
  if (!capture.inParagraph) return;
  if (is(node, 'text', 's')) { const count = repeat(node, 'text', 'c'); check(count <= LIMITS.text, 'Слишком большой пробел в тексте.'); capture.text = boundedText(doc, capture.text, ' '.repeat(count)); }
  else if (is(node, 'text', 'tab')) capture.text = boundedText(doc, capture.text, '\t');
  else if (is(node, 'text', 'line-break')) capture.text = boundedText(doc, capture.text, '\n');
}
function odfTextClose(node, capture) { if (is(node, 'text', 'p') || is(node, 'text', 'h')) capture.inParagraph--; }
async function odfCharts(doc, refs) {
  let count = 0;
  for (const ref of refs) {
    const base = resolvePart('content.xml', ref); if (!base) continue;
    const file = path.join(base.replace(/\/$/, ''), 'content.xml'); if (!doc.has(file)) continue;
    let chart = false;
    await doc.xml(file, { open(n, stack) { if (is(n, 'chartODF', 'chart') && stack.some(n => is(n, 'office', 'chart'))) chart = true; } });
    if (chart) count++;
  }
  return count;
}
async function inspectOdf(doc, format, criteria) {
  check(doc.has('content.xml') && doc.has('META-INF/manifest.xml'), 'В документе ODF нет обязательных частей.');
  await doc.xml('META-INF/manifest.xml', { open(n, stack) {
    if (stack.length === 1) check(is(n, 'manifest', 'manifest'), 'Некорректный манифест ODF.');
    check(!is(n, 'manifest', 'encryption-data') && !is(n, 'manifest', 'encrypted-key'), 'Зашифрованные документы не поддерживаются.');
    const media = attr(n, 'manifest', 'media-type') || ''; check(!/script|macro|vba/i.test(media), 'Документы с макросами не поддерживаются.');
  }});
  const targets = targetCells(criteria), sheets = [], slides = [], names = new Set();
  let sheet = null, row = null, cell = null, slide = null, frame = null, ignoredDepth = 0, familyFound = false;
  await doc.xml('content.xml', { open(n, stack) {
    const depth = stack.length;
    if (depth === 1) check(is(n, 'office', 'document-content'), 'Некорректное содержимое ODF.');
    if (stack.length > 1 && is(stack[stack.length - 2], 'office', 'scripts')) throw new OfficeError('Документы со скриптами не поддерживаются.');
    if (is(n, 'office', format === 'ods' ? 'spreadsheet' : 'presentation') && is(stack[depth - 2], 'office', 'body')) familyFound = true;
    if (format === 'ods') {
      if (is(n, 'table', 'table') && is(stack[depth - 2], 'office', 'spreadsheet')) {
        const name = attr(n, 'table', 'name'); check(name && name.length <= 180 && !names.has(name) && sheets.length < LIMITS.sheets, 'Некорректные имена листов или их слишком много.');
        names.add(name); sheet = { name, cells: cellsFor(targets, name), charts: 0, depth, nextRow: 1, refs: [] }; sheets.push(sheet);
      } else if (sheet && is(n, 'table', 'table') && depth > sheet.depth) ignoredDepth ||= depth;
      if (!sheet || ignoredDepth) return;
      if (is(n, 'table', 'table-row')) {
        check(!row, 'Вложенные строки таблицы не поддерживаются.');
        row = { start: sheet.nextRow, repeat: repeat(n, 'table', 'number-rows-repeated'), nextColumn: 1, depth };
        check(Number.isSafeInteger(row.start + row.repeat), 'Диапазон строк слишком велик.');
      } else if (row && depth === row.depth + 1 && (is(n, 'table', 'table-cell') || is(n, 'table', 'covered-table-cell'))) {
        const copies = repeat(n, 'table', 'number-columns-repeated'); check(Number.isSafeInteger(row.nextColumn + copies), 'Диапазон столбцов слишком велик.');
        const selected = Array.from(targets.get(sheet.name)?.values() || []).filter(t => t.row >= row.start && t.row < row.start + row.repeat && t.column >= row.nextColumn && t.column < row.nextColumn + copies);
        cell = { node: n, depth, start: row.nextColumn, repeat: copies, selected, text: '', paragraphs: 0, inParagraph: 0 };
      }
      if (cell && cell.selected.length && !stack.some(n => is(n, 'office', 'annotation'))) odfTextOpen(doc, n, cell);
      if (is(n, 'draw', 'object') && !stack.some(n => is(n, 'office', 'annotation'))) {
        const href = attr(n, 'xlink', 'href'); if (href) sheet.refs.push(href);
      }
    } else {
      if (is(n, 'draw', 'page') && is(stack[depth - 2], 'office', 'presentation')) {
        check(slides.length < LIMITS.slides, 'В презентации больше 256 слайдов.'); slide = { text: '', images: 0, imageGroups: [], depth, paragraphs: 0, inParagraph: 0 }; slides.push(slide);
      }
      if (!slide) return;
      if (is(n, 'presentationODF', 'notes') || is(n, 'office', 'annotation')) ignoredDepth ||= depth;
      if (ignoredDepth) return;
      if (is(n, 'draw', 'frame')) { frame = { depth, files: new Set() }; }
      if (is(n, 'draw', 'image')) {
        const href = attr(n, 'xlink', 'href'), file = href ? resolvePart('content.xml', href) : null;
        if (file && doc.has(file)) {
          if (frame) frame.files.add(file); else slide.imageGroups.push([file]);
        }
      }
      odfTextOpen(doc, n, slide);
    }
  }, text(text, stack) {
    if (ignoredDepth || stack.some(n => is(n, 'office', 'annotation'))) return;
    if (format === 'ods') { if (cell?.selected.length && cell.inParagraph) cell.text = boundedText(doc, cell.text, text); }
    else if (slide?.inParagraph) slide.text = boundedText(doc, slide.text, text);
  }, close(n, stack) {
    const depth = stack.length;
    if (ignoredDepth) { if (depth === ignoredDepth) ignoredDepth = 0; return; }
    if (format === 'ods') {
      if (cell?.selected.length && !stack.some(n => is(n, 'office', 'annotation'))) odfTextClose(n, cell);
      if (cell && depth === cell.depth) {
        if (cell.selected.length) {
          const value = odfValue(cell.node, cell.text);
          if (value.value) doc.addText(value.value === cell.text ? '' : value.value);
          if (value.formula) doc.addText(value.formula);
          for (const t of cell.selected) {
            sheet.cells[t.address] = { ...value };
            if (value.formula && (t.row !== row.start || t.column !== cell.start)) sheet.cells[t.address].formulaSupported = false;
          }
        }
        row.nextColumn += cell.repeat; cell = null;
      }
      if (row && depth === row.depth) { sheet.nextRow += row.repeat; row = null; }
      if (sheet && depth === sheet.depth) sheet = null;
    } else if (slide) {
      odfTextClose(n, slide);
      if (frame && depth === frame.depth) { if (frame.files.size) slide.imageGroups.push([...frame.files]); frame = null; }
      if (depth === slide.depth) slide = null;
    }
  }});
  check(familyFound, 'Содержимое документа не соответствует его формату.');
  if (format === 'ods') {
    for (const s of sheets) s.charts = await odfCharts(doc, s.refs);
    return { format, sheets: sheets.map(({ name, cells, charts }) => ({ name, cells, charts })) };
  }
  for (const s of slides) for (const files of s.imageGroups) { for (const file of files) await doc.verifyPart(file); s.images++; }
  return { format, slides: slides.map(({ text, images }) => ({ text, images })) };
}
async function contentTypes(doc) {
  const overrides = new Map(), defaults = new Map();
  await doc.xml('[Content_Types].xml', { open(n, stack) {
    if (stack.length === 1) check(is(n, 'contentTypes', 'Types'), 'Некорректные типы частей Office.');
    const type = attr(n, null, 'ContentType'); if (type) check(!/macro|vba|activeX/i.test(type), 'Документы с макросами не поддерживаются.');
    if (stack.length === 2 && is(n, 'contentTypes', 'Override')) {
      const name = attr(n, null, 'PartName'), file = name && resolvePart('_root', name);
      check(file && type && !overrides.has(file), 'Некорректный тип части Office.'); overrides.set(file, type);
    } else if (stack.length === 2 && is(n, 'contentTypes', 'Default')) {
      const ext = attr(n, null, 'Extension'); check(ext && type && !defaults.has(ext.toLowerCase()), 'Некорректный тип части Office.'); defaults.set(ext.toLowerCase(), type);
    }
  }});
  return file => overrides.get(file) || defaults.get(path.extname(file).slice(1).toLowerCase());
}
async function xlsxStrings(doc, part, relations) {
  const relation = Array.from(relations.values()).find(r => relKind(r.type, 'sharedStrings'));
  if (!relation) return [];
  check(relation.file && doc.has(relation.file), 'В документе отсутствует таблица строк.');
  const strings = []; let current = null;
  await doc.xml(relation.file, { open(n, stack) {
    if (stack.length === 1) check(is(n, 'sheet', 'sst'), 'Некорректная таблица строк.');
    if (stack.length === 2 && is(n, 'sheet', 'si')) current = '';
  }, text(text, stack) {
    if (current !== null && is(stack.at(-1), 'sheet', 't') && !stack.some(n => is(n, 'sheet', 'rPh'))) current = boundedText(doc, current, text);
  }, close(n, stack) { if (stack.length === 2 && is(n, 'sheet', 'si')) { strings.push(current); current = null; } }});
  return strings;
}
function xlsxValue(cell, strings, doc) {
  const { type, value, inline, formula } = cell;
  const result = { value: null, valueType: 'empty', formula: formula === null ? null : formula };
  if (cell.formulaType === 'shared' && formula === '') { result.formula = null; result.formulaSupported = false; }
  if (cell.formulaType === 'dataTable' || cell.formulaType === 'array') result.formulaSupported = false;
  if (type === 'inlineStr') { result.value = inline; result.valueType = 'text'; }
  else if (value !== null) {
    if (type === 's') {
      check(/^(?:0|[1-9]\d*)$/.test(value) && Number(value) < strings.length, 'Некорректная ссылка на таблицу строк.'); result.value = strings[Number(value)]; result.valueType = 'text';
    } else if (type === 'b') { check(value === '0' || value === '1', 'Некорректное логическое значение ячейки.'); result.value = value === '1' ? 'true' : 'false'; result.valueType = 'boolean'; }
    else if (type === 'str') { result.value = value; result.valueType = 'text'; }
    else if (type === 'e') { result.value = value; result.valueType = 'error'; }
    else if (type === 'd') { result.value = value; result.valueType = 'date'; }
    else if (type === undefined || type === 'n') { check(numeric(value), 'Некорректное числовое значение ячейки.'); result.value = value; result.valueType = 'number'; }
    else throw new OfficeError('Тип ячейки не поддерживается.');
  }
  if (result.value && type === 's') doc.addText(result.value);
  return result;
}
async function chartCount(doc, draws) {
  let count = 0;
  for (const drawing of draws) {
    const rels = await relationships(doc, drawing);
    const charts = [];
    await doc.xml(drawing, { open(n) {
      if (is(n, 'chart', 'chart')) { const r = rels.get(attr(n, 'rel', 'id')); if (r?.file && relKind(r.type, 'chart') && doc.has(r.file)) charts.push(r.file); }
    }});
    for (const file of charts) {
      let valid = false;
      await doc.xml(file, { open(n, stack) { if (stack.length === 1) check(is(n, 'chart', 'chartSpace'), 'Некорректная диаграмма.'); if (is(n, 'chart', 'chart')) valid = true; }});
      if (valid) count++;
    }
  }
  return count;
}
async function inspectXlsx(doc, main, criteria) {
  const rels = await relationships(doc, main), targets = targetCells(criteria), sheets = [], names = new Set();
  await doc.xml(main, { open(n, stack) {
    if (stack.length === 1) check(is(n, 'sheet', 'workbook'), 'Некорректная книга XLSX.');
    if (is(n, 'sheet', 'sheet') && is(stack.at(-2), 'sheet', 'sheets')) {
      const name = attr(n, null, 'name'), r = rels.get(attr(n, 'rel', 'id'));
      check(name && name.length <= 180 && !names.has(name) && sheets.length < LIMITS.sheets && r?.file && relKind(r.type, 'worksheet') && doc.has(r.file), 'Некорректный или неподдерживаемый лист книги.');
      names.add(name); sheets.push({ name, file: r.file, cells: cellsFor(targets, name), charts: 0 });
    }
  }});
  const strings = await xlsxStrings(doc, main, rels);
  for (const s of sheets) {
    let cell = null, row = null, nextRow = 1; const seen = new Set(), draws = [], relations = await relationships(doc, s.file);
    await doc.xml(s.file, { open(n, stack) {
      if (stack.length === 1) check(is(n, 'sheet', 'worksheet'), 'Некорректный лист XLSX.');
      if (is(n, 'sheet', 'drawing')) {
        const r = relations.get(attr(n, 'rel', 'id')); if (r?.file && relKind(r.type, 'drawing') && doc.has(r.file)) draws.push(r.file);
      }
      if (is(n, 'sheet', 'row') && is(stack.at(-2), 'sheet', 'sheetData')) {
        const raw = attr(n, null, 'r'); check(raw === undefined || /^[1-9][0-9]{0,6}$/.test(raw), 'Некорректный номер строки XLSX.');
        const number = raw === undefined ? nextRow : Number(raw); check(number <= 1048576 && number >= nextRow, 'Некорректный порядок строк XLSX.');
        row = { number, depth: stack.length, nextColumn: 1 }; nextRow = number + 1;
      } else if (row && is(n, 'sheet', 'c') && stack.length === row.depth + 1) {
        const address = attr(n, null, 'r') ?? `${columnLetters(row.nextColumn)}${row.number}`;
        const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address), column = match && columnNumber(match[1]);
        check(match && Number(match[2]) === row.number && column <= 16384 && column >= row.nextColumn, 'Некорректный адрес или порядок ячеек XLSX.');
        row.nextColumn = column + 1;
        if (Object.hasOwn(s.cells, address)) {
          check(!seen.has(address), 'Проверяемая ячейка повторяется.'); seen.add(address);
          cell = { address, type: attr(n, null, 't'), depth: stack.length, value: null, inline: '', formula: null, formulaType: null };
        }
      } else if (cell && is(n, 'sheet', 'f') && stack.length === cell.depth + 1) { cell.formula = ''; cell.formulaType = attr(n, null, 't'); }
      else if (cell && is(n, 'sheet', 'v') && stack.length === cell.depth + 1) cell.value = '';
    }, text(text, stack) {
      if (!cell) return;
      if (is(stack.at(-1), 'sheet', 'v') && stack.length === cell.depth + 1) cell.value = boundedText(doc, cell.value, text);
      else if (is(stack.at(-1), 'sheet', 'f') && stack.length === cell.depth + 1) cell.formula = boundedText(doc, cell.formula, text);
      else if (is(stack.at(-1), 'sheet', 't') && stack.some(n => is(n, 'sheet', 'is')) && !stack.some(n => is(n, 'sheet', 'rPh'))) cell.inline = boundedText(doc, cell.inline, text);
    }, close(_n, stack) {
      if (cell && stack.length === cell.depth) { s.cells[cell.address] = xlsxValue(cell, strings, doc); cell = null; }
      if (row && stack.length === row.depth) row = null;
    }});
    s.charts = await chartCount(doc, draws);
  }
  return { format: 'xlsx', sheets: sheets.map(({ name, cells, charts }) => ({ name, cells, charts })) };
}
async function inspectPptx(doc, main) {
  const rels = await relationships(doc, main), parts = [];
  await doc.xml(main, { open(n, stack) {
    if (stack.length === 1) check(is(n, 'presentation', 'presentation'), 'Некорректная презентация PPTX.');
    if (is(n, 'presentation', 'sldId') && is(stack.at(-2), 'presentation', 'sldIdLst')) {
      const r = rels.get(attr(n, 'rel', 'id')); check(parts.length < LIMITS.slides && r?.file && relKind(r.type, 'slide') && doc.has(r.file) && !parts.includes(r.file), 'Некорректный список слайдов.'); parts.push(r.file);
    }
  }});
  const slides = [];
  for (const file of parts) {
    const relations = await relationships(doc, file);
    const slide = { text: '', images: 0 }, imageGroups = []; let picture = null, paragraphs = 0;
    const visibility = [], hidden = () => visibility.some(shape => shape.hidden);
    await doc.xml(file, { open(n, stack) {
      const depth = stack.length;
      if (depth === 1) check(is(n, 'presentation', 'sld'), 'Некорректный слайд PPTX.');
      if (['sp', 'pic', 'graphicFrame', 'grpSp'].some(name => is(n, 'presentation', name))) visibility.push({ depth, hidden: false });
      if (visibility.length && is(n, 'presentation', 'cNvPr') && ['1', 'true'].includes(attr(n, null, 'hidden'))) visibility.at(-1).hidden = true;
      if (is(n, 'presentation', 'pic')) picture = { depth, files: new Set() };
      if (picture && is(n, 'drawing', 'blip')) {
        const r = relations.get(attr(n, 'rel', 'embed')); if (r?.file && relKind(r.type, 'image') && doc.has(r.file)) picture.files.add(r.file);
      }
      const inTextBody = stack.some(n => is(n, 'presentation', 'txBody') || is(n, 'drawing', 'txBody'));
      if (!hidden() && inTextBody && is(n, 'drawing', 'p')) { if (paragraphs++) slide.text = boundedText(doc, slide.text, '\n'); }
      if (!hidden() && inTextBody && is(n, 'drawing', 'br')) slide.text = boundedText(doc, slide.text, '\n');
    }, text(text, stack) {
      if (!hidden() && is(stack.at(-1), 'drawing', 't') && stack.some(n => is(n, 'presentation', 'txBody') || is(n, 'drawing', 'txBody'))) slide.text = boundedText(doc, slide.text, text);
    }, close(_n, stack) {
      if (picture && stack.length === picture.depth) { if (picture.files.size && !hidden()) imageGroups.push([...picture.files]); picture = null; }
      if (visibility.at(-1)?.depth === stack.length) visibility.pop();
    }});
    for (const files of imageGroups) { for (const file of files) await doc.verifyPart(file); slide.images++; }
    slides.push(slide);
  }
  return { format: 'pptx', slides };
}
async function parseOffice(data, family, criteria) {
  const doc = new Document(data);
  if (doc.has('mimetype')) {
    const mimetype = decodeUtf8(await doc.read('mimetype', 256));
    const format = mimetype === 'application/vnd.oasis.opendocument.spreadsheet' ? 'ods' : mimetype === 'application/vnd.oasis.opendocument.presentation' ? 'odp' : null;
    check(format, 'Нужен документ ODS, XLSX, ODP или PPTX.');
    check((family === 'spreadsheet') === (format === 'ods'), 'Прикреплён документ другого типа.');
    return inspectOdf(doc, format, criteria);
  }
  check(doc.has('[Content_Types].xml') && doc.has('_rels/.rels'), 'Нужен документ ODS, XLSX, ODP или PPTX.');
  const typeOf = await contentTypes(doc), rels = await relationships(doc, ''), mains = Array.from(rels.values()).filter(r => relKind(r.type, 'officeDocument'));
  check(mains.length === 1 && mains[0].file && doc.has(mains[0].file), 'Некорректная главная часть Office.');
  const main = mains[0].file, type = typeOf(main), prefix = 'application/vnd.openxmlformats-officedocument.';
  const format = type === `${prefix}spreadsheetml.sheet.main+xml` ? 'xlsx' : type === `${prefix}presentationml.presentation.main+xml` ? 'pptx' : null;
  check(format, 'Поддерживаются обычные XLSX и PPTX без макросов.');
  check((family === 'spreadsheet') === (format === 'xlsx'), 'Прикреплён документ другого типа.');
  return format === 'xlsx' ? inspectXlsx(doc, main, criteria) : inspectPptx(doc, main);
}
async function inspectOffice(data, type, criteria = []) {
  check(Buffer.isBuffer(data) && data.length > 0 && data.length <= LIMITS.archive, 'Документ должен быть не больше 32 МБ.');
  check(['spreadsheet', 'presentation'].includes(type) && Array.isArray(criteria) && criteria.length <= LIMITS.criteria, 'Некорректная настройка проверки документа.');
  // Copy into a dedicated buffer so transfer does not detach the caller's answer.
  const bytes = new Uint8Array(data.length); bytes.set(data);
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { officeWorker: true, data: bytes, type, criteria }, transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    let finished = false;
    const timer = setTimeout(() => finish(new OfficeError('Документ слишком сложен: время проверки превышено.')), LIMITS.wallMs);
    function finish(error, result) {
      if (finished) return; finished = true; clearTimeout(timer); worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    }
    worker.once('message', message => finish(message.error ? new OfficeError(message.error) : null, message.result));
    worker.once('error', () => finish(new OfficeError('Не удалось безопасно прочитать документ.')));
    worker.once('exit', code => { if (!finished) finish(new OfficeError(code ? 'Документ превышает ограничения безопасной проверки.' : 'Проверка документа не завершена.')); });
  });
}
if (!isMainThread && workerData?.officeWorker === true) {
  parseOffice(Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength), workerData.type, workerData.criteria)
    .then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error instanceof OfficeError ? error.message : 'Не удалось прочитать структуру документа.' }));
}
module.exports = { inspectOffice, LIMITS, OfficeError };
