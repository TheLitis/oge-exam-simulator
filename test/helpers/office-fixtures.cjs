'use strict';
const JSZip = require('../../vendor/jszip.cjs');
const O = 'urn:oasis:names:tc:opendocument:xmlns:';
const X = 'http://schemas.openxmlformats.org/';
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
async function pack(parts, options = {}) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(parts)) zip.file(name, data, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX', ...options });
}
function odfParts(family, body, extra = {}) {
  const ns = ['office', 'table', 'text', 'draw', 'presentation', 'chart'].map(name => `xmlns:${name}="${O}${name === 'draw' ? 'drawing' : name}:1.0"`).join(' ');
  return {
    mimetype: `application/vnd.oasis.opendocument.${family}`,
    'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="${O}manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.${family}"/></manifest:manifest>`,
    'content.xml': `<office:document-content ${ns} xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:${family}>${body}</office:${family}></office:body></office:document-content>`,
    ...extra,
  };
}
const ods = (body, extra) => pack(odfParts('spreadsheet', body, extra));
const odp = (body, extra) => pack(odfParts('presentation', body, extra));
function relationships(rows) {
  return `<Relationships xmlns="${X}package/2006/relationships">${rows.map(([id, kind, target, external]) => `<Relationship Id="${xml(id)}" Type="${X}officeDocument/2006/relationships/${kind}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}
function xlsxParts(sheets, extra = {}) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="${X}package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    '_rels/.rels': relationships([['main', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `<workbook xmlns="${X}spreadsheetml/2006/main" xmlns:r="${X}officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="r${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships(sheets.map((s, i) => [`r${i + 1}`, 'worksheet', s.file || `worksheets/sheet${i + 1}.xml`]).concat([['strings', 'sharedStrings', 'sharedStrings.xml']])),
    'xl/sharedStrings.xml': `<sst xmlns="${X}spreadsheetml/2006/main"><si><t>Привет</t></si></sst>`,
  };
  sheets.forEach((s, i) => { files[`xl/${s.file || `worksheets/sheet${i + 1}.xml`}`] = `<worksheet xmlns="${X}spreadsheetml/2006/main" xmlns:r="${X}officeDocument/2006/relationships"><sheetData>${s.rows || ''}</sheetData>${s.after || ''}</worksheet>`; });
  return { ...files, ...extra };
}
const xlsx = (sheets, extra) => pack(xlsxParts(sheets, extra));
function pptxParts(slides, extra = {}) {
  const parts = {
    '[Content_Types].xml': `<Types xmlns="${X}package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': relationships([['main', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `<p:presentation xmlns:p="${X}presentationml/2006/main" xmlns:r="${X}officeDocument/2006/relationships"><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${i + 256}" r:id="r${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships(slides.map((s, i) => [`r${i + 1}`, 'slide', `slides/${s.file || `slide${i + 1}.xml`}`])),
  };
  slides.forEach((s, i) => { const file = s.file || `slide${i + 1}.xml`; parts[`ppt/slides/${file}`] = `<p:sld xmlns:p="${X}presentationml/2006/main" xmlns:a="${X}drawingml/2006/main" xmlns:r="${X}officeDocument/2006/relationships"${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${s.body || `<p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(s.text || '')}</a:t></a:r></a:p></p:txBody></p:sp>`}</p:spTree></p:cSld></p:sld>`; if (s.rels) parts[`ppt/slides/_rels/${file}.rels`] = relationships(s.rels); });
  return { ...parts, ...extra };
}
const pptx = (slides, extra) => pack(pptxParts(slides, extra));
module.exports = { pack, odfParts, ods, odp, xlsxParts, xlsx, pptxParts, pptx, relationships, O, X };
