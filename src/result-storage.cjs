'use strict';
const { fs, fsp, path, crypto, JSZip, LIMITS, check, mkdir, json, readJson, inside, safeName, hashFile, boundedCopy, preflightZip } = require('./io.cjs');
const P = require('./result-protection.cjs');
const M = require('./model.cjs');
const R = require('./review.cjs');
const { Transform } = require('node:stream');
const UUID = /^[a-f0-9-]{36}$/;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const csv = v => '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, x => "'" + x).replace(/"/g, '""') + '"';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');

// JSON and generated reports never visit the filesystem before encryption.
async function resultEntries(a, exam, dir) {
  const answers = [], drafts = {}, files = [];
  for (let id = 1; id <= 16; id++) {
    const answer = a.answers[id], record = { task:id, kind:M.taskKind(id), saved:M.answered(answer), savedAt:answer?.savedAt ?? null };
    if (record.kind === 'short') record.answer = answer?.text ?? '';
    if (answer?.file) {
      const f = answer.file, file = inside(dir, f.path), rel = `files/task-${id}/${safeName(f.name)}`;
      check(/^blobs\/[a-f0-9-]{36}$/.test(f.path),'Некорректный файл ответа.');
      const stat=await fsp.lstat(file);check(stat.isFile() && !stat.isSymbolicLink() && stat.size===f.size,'Файл ответа повреждён.');
      check(await hashFile(file) === f.sha256, `Файл ответа ${id} повреждён. Сеанс сохранён.`);
      files.push({ name:rel, file, sha256:f.sha256, size:f.size });
      record.file = { path:rel, name:f.name, size:f.size, sha256:f.sha256 };
    }
    if (M.dirty(a, id)) {
      if (record.kind === 'short') drafts[id] = { text:a.drafts[id], submitted:false };
      else {
        const f = a.draftFiles[id], file = inside(dir, f.path), rel = `draft-files/task-${id}/${safeName(f.name)}`;
        check(/^blobs\/[a-f0-9-]{36}$/.test(f.path),'Некорректный файл черновика.');
        const stat=await fsp.lstat(file);check(stat.isFile() && !stat.isSymbolicLink() && stat.size===f.size,'Файл черновика повреждён.');
        check(await hashFile(file) === f.sha256, `Черновик задания ${id} повреждён. Сеанс сохранён.`);
        files.push({ name:rel, file, sha256:f.sha256, size:f.size });
        drafts[id] = { file:rel, sha256:f.sha256, submitted:false };
      }
    }
    answers.push(record);
  }
  const iso = ms => new Date(ms).toISOString();
  const meta = { format:'oge-results', version:1, sessionId:a.id, examId:a.examId, examTitle:a.title,
    startedAt:iso(a.startedAt), deadlineAt:iso(a.deadlineAt), finishedAt:iso(a.finishedAt),
    elapsedSeconds:Math.round(a.elapsedMs / 1000), finishReason:a.finishReason, savedCount:answers.filter(x => x.saved).length };
  const add = (name, data) => files.push({ name, data:Buffer.from(data) });
  const addJson = (name, data) => {const text=JSON.stringify(data,null,2);check(Buffer.byteLength(text)<=LIMITS.json,`${name} превышает 1 МБ. Сеанс сохранён.`);add(name,text);};
  addJson('candidate.json', a.candidate);
  addJson('answers.json', { ...meta, answers });
  addJson('grading-context.json', R.gradingContext(exam));
  addJson('drafts.json', { note:'Черновики не являются сохранёнными ответами. Не оценивать без решения организатора.', drafts });
  addJson('events.json', a.events);
  add('answers.csv', '\ufeff' + ['Задание;Тип;Сохранён;Ответ или файл;Время сохранения', ...answers.map(r => [r.task,r.kind,r.saved?'да':'нет',r.answer ?? r.file?.path ?? '',r.savedAt].map(csv).join(';'))].join('\r\n'));
  const rows = answers.map(r => `<tr><td>${r.task}</td><td>${r.saved?'Сохранён':'Нет ответа'}</td><td>${esc(r.answer ?? r.file?.name ?? '—')}</td></tr>`).join('');
  add('report.html', `<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Результат экзамена</title><style>body{font:16px/1.6 sans-serif;max-width:1000px;margin:40px auto;padding:24px;color:#152c3c}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:10px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:26px}</style><h1>${esc(a.title)}</h1><p>${esc(a.candidate.surname)} ${esc(a.candidate.name)} · Бланк ${esc(a.candidate.registration)}</p><p>Сохранено: ${meta.savedCount}/16.<br>Начало: ${esc(meta.startedAt)}<br>Завершение: ${esc(meta.finishedAt)}</p><table><thead><tr><th>Задание</th><th>Статус</th><th>Ответ / файл</th></tr></thead><tbody>${rows}</tbody></table><p>Черновики не оценивались. Автоматическое оценивание не выполнялось.</p></html>`);
  add('README.txt', 'Работа локального учебного экзамена. Внешний файл .ogeresult зашифрован для учителя.\nПосле расшифрования этот ZIP содержит персональные данные. Не публикуйте его.\nСохранённые ответы: answers.json, answers.csv, report.html и files/.\nЧерновики: drafts.json, draft-files/ — не являются сданными ответами.\nSHA256.json обнаруживает повреждение; это не цифровая подпись ученика.\n');
  const sums = {}; for (const f of files) sums[f.name] = f.sha256 || digest(f.data);
  addJson('SHA256.json', sums);
  check(files.reduce((n, f) => n + (f.size ?? f.data.length), 0) <= LIMITS.expanded, 'Работа превышает 512 МБ. Сеанс сохранён.');
  return files;
}
function zipStream(files) {
  const zip = new JSZip();
  for (const { name, file, data, sha256, size } of files) {
    let source=data;
    if(file) {
      const hash=crypto.createHash('sha256');let length=0;
      const verify=new Transform({transform(chunk,_enc,cb){length+=chunk.length;if(length>size)return cb(new Error('Файл ответа изменился при экспорте.'));hash.update(chunk);cb(null,chunk);},
        flush(cb){cb(length===size && hash.digest('hex')===sha256?null:new Error('Файл ответа изменился при экспорте.'));}});
      const input=fs.createReadStream(file);input.on('error',e=>verify.destroy(e));verify.on('close',()=>input.destroy());source=input.pipe(verify);
    }
    zip.file(name,source,{createFolders:false,unixPermissions:0o100600});
  }
  return zip.generateNodeStream({ type:'nodebuffer', streamFiles:true, compression:'DEFLATE', compressionOptions:{level:6}, platform:'UNIX' });
}
async function copyVerified(source, dest, expected) {
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`; await mkdir(path.dirname(dest));
  try {
    const got = await boundedCopy(fs.createReadStream(source), tmp, P.RESULT_LIMIT);
    check(got.sha256 === expected, 'Зашифрованная копия работы повреждена. Оригинал сохранён.');
    await fsp.rename(tmp, dest);
    if (process.platform !== 'win32') { const h = await fsp.open(path.dirname(dest), 'r'); try { await h.sync(); } finally { await h.close(); } }
  } finally { await fsp.rm(tmp, {force:true}).catch(() => {}); }
}
function receiptFor(a, recipient, sha256) {
  return { format:'oge-result-receipt', schema:2, sealed:true, id:a.id, examId:a.examId, title:a.title,
    startedAt:a.startedAt, deadlineAt:a.deadlineAt, finishedAt:a.finishedAt, durationSeconds:M.DURATION,
    elapsedMs:a.elapsedMs, finishReason:a.finishReason, currentTask:a.currentTask, status:'finished',
    statuses:Array.from({length:16}, (_, i) => ({id:i+1,saved:M.answered(a.answers[i+1]),dirty:M.dirty(a,i+1)})),
    recipientId:recipient.keyId, archiveSha256:sha256, resultDir:null, archivePath:null, exportError:null };
}
async function readReceipt(dir, id) {
  const file = path.join(dir, 'receipt.json'), st = await fsp.lstat(file);
  check(st.isFile() && !st.isSymbolicLink() && st.size <= 65536, 'Повреждена квитанция работы.');
  const r = await readJson(file);
  check(r?.format === 'oge-result-receipt' && r.schema === 2 && r.sealed === true && r.status === 'finished' && UUID.test(id) && r.id === id &&
    r.durationSeconds === M.DURATION && Number.isFinite(r.startedAt) && Number.isFinite(r.finishedAt) && Number.isFinite(r.elapsedMs) &&
    typeof r.title === 'string' && r.title.length <= 160 && /^[a-f0-9]{64}$/.test(r.archiveSha256) &&
    (r.publication===undefined || UUID.test(r.publication)) &&
    Array.isArray(r.statuses) && r.statuses.length === 16 && r.statuses.every((s,i) => s.id === i+1 && typeof s.saved === 'boolean' && typeof s.dirty === 'boolean'), 'Повреждена квитанция работы.');
  const backup = path.join(dir, 'result.ogeresult');
  let bs;try {bs=await fsp.lstat(backup);}catch(e){if(e.code==='ENOENT')check(false,'Зашифрованная резервная работа отсутствует. Существующие файлы сохранены.');throw e;}
  check(bs.isFile() && !bs.isSymbolicLink() && bs.size <= P.RESULT_LIMIT && await P.isEncryptedResult(backup) && await hashFile(backup) === r.archiveSha256,
    'Зашифрованная резервная работа повреждена. Существующие файлы сохранены.');
  return r;
}
async function cleanupSession(dir) {
  const st = await fsp.lstat(dir); check(st.isDirectory() && !st.isSymbolicLink(), 'Папка сеанса недоступна.');
  // Call only after readReceipt has verified the durable encrypted backup.
  for (const name of ['session.json','session.json.bak','blobs']) await fsp.rm(path.join(dir, name), {recursive:true,force:true});
  for (const name of await fsp.readdir(dir)) if (/^session\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) await fsp.rm(path.join(dir,name),{force:true});
}
async function sealSession(a, exam, dir, recipient, {sourceZip} = {}) {
  const backup = path.join(dir, 'result.ogeresult');
  if(sourceZip)await P.encryptFile(sourceZip,backup,recipient);
  else await P.encryptStream(zipStream(await resultEntries(a, exam, dir)), backup, recipient);
  const receipt = receiptFor(a, recipient, await hashFile(backup));
  // Persist only non-personal receipt data; recovery uses the encrypted copy.
  await json(path.join(dir,'receipt.json'),receipt);
  await readReceipt(dir,a.id); await cleanupSession(dir);
  return receipt;
}
function visibleArchive(receipt,resultsRoot) {
  return path.join(resultsRoot,`OGE_${new Date(receipt.startedAt).toISOString().slice(0,10)}_${receipt.id}${receipt.publication?'_'+receipt.publication:''}`,'result.ogeresult');
}
async function publishReceipt(receipt, dir, resultsRoot) {
  const backup = path.join(dir, 'result.ogeresult');
  await readReceipt(dir,receipt.id);
  // Never trust paths supplied by a writable receipt to choose a write target.
  let nextReceipt={...receipt},archivePath=visibleArchive(nextReceipt,resultsRoot),final=path.dirname(archivePath);
  let present = false;
  let collision=false;
  try {
    const folder=await fsp.lstat(final);
    collision=!folder.isDirectory() || folder.isSymbolicLink();
    if(!collision) {
      try {const s=await fsp.lstat(archivePath);present=s.isFile() && !s.isSymbolicLink() && await hashFile(archivePath)===receipt.archiveSha256;collision=!present;}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(collision) {nextReceipt.publication=crypto.randomUUID();archivePath=visibleArchive(nextReceipt,resultsRoot);final=path.dirname(archivePath);}
  await mkdir(final);const folder=await fsp.lstat(final);check(folder.isDirectory() && !folder.isSymbolicLink(),'Папка результатов недоступна.');
  if (!present) await copyVerified(backup,archivePath,receipt.archiveSha256);
  const next = {...nextReceipt,resultDir:final,archivePath,exportError:null};
  await json(path.join(dir,'receipt.json'),next); return next;
}

// Remove a legacy unpacked folder only when every file is the exact original
// ZIP entry. Unexpected files stay untouched and are reported for review.
async function removeMatchingFolder(folder, zipFile) {
  let st; try { st = await fsp.lstat(folder); } catch(e) { if(e.code==='ENOENT')return true; throw e; }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  const inputStat=await fsp.lstat(zipFile);check(inputStat.isFile() && !inputStat.isSymbolicLink() && inputStat.size<=LIMITS.archive,'Прежний ZIP недоступен.');
  const buffer = await fsp.readFile(zipFile), entries = preflightZip(buffer,'answers.json');
  const zip = await JSZip.loadAsync(buffer,{createFolders:false}), expected = new Map();
  for(const e of entries) {
    let size=0;const hash=crypto.createHash('sha256');
    for await(const chunk of zip.file(e.name).nodeStream('nodebuffer')) {size+=chunk.length;check(size<=e.size && size<=LIMITS.file,'Размер прежнего ZIP превышает каталог.');hash.update(chunk);}
    check(size===e.size,'Прежний ZIP повреждён.');expected.set(e.name,{size,hash:hash.digest('hex')});
  }
  let count = 0;
  async function walk(dir,prefix='') {
    for(const ent of await fsp.readdir(dir,{withFileTypes:true})) {
      if(ent.isSymbolicLink())return false;
      const rel=prefix+ent.name, file=path.join(dir,ent.name);
      if(ent.isDirectory()){if(!await walk(file,rel+'/'))return false;}
      else {const want=expected.get(rel), stat=await fsp.lstat(file); if(!want || !stat.isFile() || stat.size!==want.size || await hashFile(file)!==want.hash)return false; count++;}
    } return true;
  }
  if(!await walk(folder) || count!==expected.size)return false;
  await fsp.rm(folder,{recursive:true,force:true}); return true;
}
async function legacyFolderEntries(folder) {
  const roots=new Set(['answers.json','candidate.json','drafts.json','events.json','answers.csv','report.html','README.txt','SHA256.json','grading-context.json']);
  const files=[];let total=0;
  async function walk(dir,prefix='') {
    for(const entry of await fsp.readdir(dir,{withFileTypes:true})) {
      check(!entry.isSymbolicLink(),'Ссылка в прежней папке результатов.');
      const name=prefix+entry.name,file=path.join(dir,entry.name);
      if(entry.isDirectory()) {
        check(/^(?:files|draft-files)(?:\/task-(?:[1-9]|1[0-6]))?$/.test(name),'Неизвестная папка в прежних результатах.');await walk(file,name+'/');
      }else {
        const answer=/^(?:files|draft-files)\/task-(?:[1-9]|1[0-6])\/([^/]+)$/.exec(name);
        check(entry.isFile() && (roots.has(name) || (answer && safeName(answer[1]))),'Неизвестный файл в прежних результатах.');
        const stat=await fsp.lstat(file);check(stat.size<=LIMITS.file && (!name.endsWith('.json') || answer || stat.size<=LIMITS.json),'Прежний файл слишком большой.');
        total+=stat.size;check(total<=LIMITS.expanded && files.length<LIMITS.entries,'Прежние результаты слишком большие.');
        files.push({name,file,size:stat.size,sha256:await hashFile(file)});
      }
    }
  }
  const st=await fsp.lstat(folder);check(st.isDirectory() && !st.isSymbolicLink(),'Прежняя папка недоступна.');await walk(folder);
  const sums=await readJson(path.join(folder,'SHA256.json'));check(sums && typeof sums==='object' && !Array.isArray(sums),'Прежние контрольные суммы повреждены.');
  const content=files.filter(f=>f.name!=='SHA256.json');check(Object.keys(sums).length===content.length && content.every(f=>sums[f.name]===f.sha256),'Прежняя папка результатов повреждена. Оригинал сохранён.');
  return files;
}
module.exports = { resultEntries, zipStream, copyVerified, readReceipt, cleanupSession, sealSession, publishReceipt, visibleArchive, removeMatchingFolder, legacyFolderEntries };
