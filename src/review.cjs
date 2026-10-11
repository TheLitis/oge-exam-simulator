'use strict';
const { fsp, path, crypto, JSZip, LIMITS, check, mkdir, json, safeName, inside, hashFile, boundedCopy, preflightZip, writeZip } = require('./io.cjs');
const UUID = /^[a-f0-9-]{36}$/;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csv = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, x => "'" + x).replace(/"/g, '""') + '"';
const labels = { correct:'Верно', incorrect:'Неверно', unanswered:'Нет ответа', manual:'Ручная проверка', error:'Ошибка проверки', unavailable:'Проверка недоступна' };

function gradingContext(exam) {
  return { format:'oge-grading-context', version:1, tasks:exam.tasks.map(t => ({id:t.id,
    images:t.images.map(a => ({name:a.name,sha256:a.sha256})), resources:t.resources.map(a => ({name:a.name,sha256:a.sha256})) })) };
}
function contextMatches(value, exam) {
  check(value?.format === 'oge-grading-context' && value.version === 1 && Array.isArray(value.tasks) && value.tasks.length === 16, 'Повреждён состав варианта в ZIP.');
  for (let i=0;i<16;i++) {
    const t=value.tasks[i]; check(t?.id===i+1, 'Повреждён порядок заданий в ZIP.');
    for (const field of ['images','resources']) {
      check(Array.isArray(t[field]) && t[field].length <= 16, 'Повреждён состав задания в ZIP.');
      for (const a of t[field]) { safeName(a?.name); check(/^[a-f0-9]{64}$/.test(a.sha256), 'Повреждён хеш условия в ZIP.'); }
    }
  }
  return JSON.stringify(value.tasks) === JSON.stringify(gradingContext(exam).tasks);
}
async function entryJson(zip, name, entries) {
  const item=entries.find(e=>e.name===name); check(item && item.size <= LIMITS.json, `В ZIP нет ${name} или он слишком большой.`);
  const chunks=[]; let size=0;
  for await (const chunk of zip.file(name).nodeStream('nodebuffer')) {
    size+=chunk.length; check(size<=LIMITS.json && size<=item.size, 'Размер JSON превышает каталог ZIP.'); chunks.push(chunk);
  }
  check(size===item.size, 'Размер JSON не совпадает с ZIP.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { check(false, `Некорректный ${name}.`); }
}
async function importResult(file, root, exam) {
  const st=await fsp.lstat(file); check(st.isFile() && !st.isSymbolicLink() && st.size<=LIMITS.archive, 'Недопустимый ZIP результатов.');
  const buffer=await fsp.readFile(file), entries=preflightZip(buffer,'answers.json');
  const zip=await JSZip.loadAsync(buffer,{createFolders:false});
  for (const e of entries) check(zip.file(e.name) && !zip.file(e.name).dir, 'Повреждён файл результатов.');
  const sums=await entryJson(zip,'SHA256.json',entries);
  check(sums && typeof sums==='object' && !Array.isArray(sums), 'Некорректные контрольные суммы ZIP.');
  const content=entries.filter(e=>e.name!=='SHA256.json');
  check(Object.keys(sums).length===content.length, 'Не все файлы ZIP имеют контрольную сумму.');
  for (const item of content) {
    check(Object.hasOwn(sums,item.name) && /^[a-f0-9]{64}$/.test(sums[item.name]), 'Нет контрольной суммы файла ZIP.');
    let size=0; const hash=crypto.createHash('sha256');
    for await (const chunk of zip.file(item.name).nodeStream('nodebuffer')) {
      size+=chunk.length; check(size<=item.size && size<=LIMITS.file, 'Размер файла превышает каталог ZIP.'); hash.update(chunk);
    }
    check(size===item.size && hash.digest('hex')===sums[item.name], `Файл ${item.name} повреждён.`);
  }
  const data=await entryJson(zip,'answers.json',entries), person=await entryJson(zip,'candidate.json',entries);
  check(data?.format==='oge-results' && data.version===1 && UUID.test(data.sessionId) && Array.isArray(data.answers) && data.answers.length===16, 'Неподдерживаемый формат результатов.');
  check(typeof data.examTitle==='string' && data.examTitle.length<=160, 'Некорректное название экзамена.');
  for (const k of ['registration','surname','name']) check(typeof person?.[k]==='string' && person[k].length>0 && person[k].length<=80, 'Повреждены данные участника.');
  const id=crypto.randomUUID(), dir=inside(root,id); await mkdir(dir);
  try {
    const answers={}, view=[];
    for (let index=0;index<16;index++) {
      const r=data.answers[index], task=index+1, kind=task<=12?'short':'file';
      check(r?.task===task && r.kind===kind && typeof r.saved==='boolean', 'Повреждена таблица ответов.');
      if (kind==='short') {
        check(typeof r.answer==='string' && r.answer.length<=4096, 'Краткий ответ слишком большой или повреждён.');
        check(!r.saved || r.answer.trim().length>0, 'Сдан пустой краткий ответ.');
        if (r.saved) answers[task]={kind,text:r.answer};
        view.push({id:task,kind,text:r.saved?r.answer:''});
      } else {
        if (r.saved) {
          const a=r.file; safeName(a?.name);
          check(a.path===`files/task-${task}/${a.name}` && Number.isSafeInteger(a.size) && a.size>=0 && a.size<=LIMITS.file && /^[a-f0-9]{64}$/.test(a.sha256), 'Повреждён файл ответа.');
          const item=entries.find(e=>e.name===a.path); check(item && item.size===a.size && sums[a.path]===a.sha256, 'Файл ответа отсутствует или повреждён.');
          const rel=`blobs/${crypto.randomUUID()}`, target=inside(dir,rel);
          const copied=await boundedCopy(zip.file(a.path).nodeStream('nodebuffer'),target,a.size);
          check(copied.size===a.size && copied.sha256===a.sha256, 'Копия ответа повреждена.');
          answers[task]={kind,file:{path:rel,name:a.name,...copied}};
        }
        view.push({id:task,kind,fileName:r.saved?r.file.name:null});
      }
    }
    let draftCount=0;
    if (zip.file('drafts.json')) {
      const d=await entryJson(zip,'drafts.json',entries); check(d?.drafts && typeof d.drafts==='object' && !Array.isArray(d.drafts), 'Повреждены черновики.');
      check(Object.keys(d.drafts).every(k=>/^(?:[1-9]|1[0-6])$/.test(k)), 'Повреждены номера черновиков.'); draftCount=Object.keys(d.drafts).length;
    }
    const context=zip.file('grading-context.json')?await entryJson(zip,'grading-context.json',entries):null;
    const contextMatch=context?contextMatches(context,exam):null;
    await fsp.copyFile(file,path.join(dir,'original-results.zip'));
    const record={id,registration:person.registration,surname:person.surname,name:person.name,title:data.examTitle,
      savedCount:Object.keys(answers).length,draftCount,contextMatch,answers:view,context,
      attempt:{answers}, originalSha256:digest(buffer), importedAt:new Date().toISOString()};
    await json(path.join(dir,'review.json'),record); return record;
  } catch (e) { await fsp.rm(dir,{recursive:true,force:true}); throw e; }
}
function reviewView(record) {
  const {attempt,context,originalSha256,...view}=record;
  return {...view, warning:record.contextMatch===false?'Условия отличаются от открытого проекта.':record.contextMatch===null?'В этом ZIP нет состава условий. Сопоставьте вариант с проектом.':null};
}
async function writeReviewReport(record, assessment, dir) {
  const checkedAt=new Date().toISOString(), data={format:'oge-assessment',version:1,checkedAt,originalSha256:record.originalSha256,
    candidate:{registration:record.registration,surname:record.surname,name:record.name},examTitle:record.title,
    contextMatch:record.contextMatch,assessment};
  await json(path.join(dir,'assessment.json'),data);
  const rows=assessment.tasks.map(t=>{
    const tests=t.tests?.map(test=>`<p><strong>Тест ${test.index}: ${esc(labels[test.status]||test.status)}</strong><br>${esc(test.message)}${test.actual!==undefined?`<br>Получено:<br>${esc(test.actual)}`:''}</p>`).join('')||'';
    const criteria=t.criteria?.map(item=>`<p><strong>${item.index}. ${esc(item.label)}: ${esc(labels[item.status]||item.status)}</strong><br>${esc(item.message)}${item.expected!==undefined?`<br>Ожидалось: ${esc(item.expected)}`:''}${item.actual!==undefined?`<br>Получено: ${esc(item.actual)}`:''}</p>`).join('')||'';
    return `<tr><td>${t.id}</td><td>${esc(labels[t.status]||t.status)}</td><td>${esc(t.message)}${tests}${criteria}</td><td>${esc(t.actual??'')}</td></tr>`;
  }).join('');
  await fsp.writeFile(path.join(dir,'assessment.html'),`<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Проверка работы</title><style>body{font:16px/1.6 sans-serif;max-width:1100px;margin:32px auto;padding:24px;color:#202b25}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Проверка работы</h1><p>${esc(record.surname)} ${esc(record.name)} · Бланк ${esc(record.registration)}<br>${esc(record.title)}<br>${esc(checkedAt)}</p><p>Верно: ${assessment.summary.correct}; неверно: ${assessment.summary.incorrect}. Это результат заданных эталонов и тестов, а не официальная оценка. Черновики не оценивались.${record.contextMatch!==true?' Состав условий не подтверждён; учитель разрешил использовать текущий проект.':''}</p><table><thead><tr><th>Задание</th><th>Результат</th><th>Подробности</th><th>Получено</th></tr></thead><tbody>${rows}</tbody></table></html>`,{mode:0o600});
  await fsp.writeFile(path.join(dir,'assessment.csv'),'\ufeff'+['Задание;Результат;Подробности;Получено',...assessment.tasks.map(t=>[t.id,labels[t.status]||t.status,
    [t.message,...(t.criteria||[]).map(item=>`${item.index}. ${item.label}: ${labels[item.status]||item.status}. ${item.message}${item.expected!==undefined?` Ожидалось: ${item.expected}.`:''}${item.actual!==undefined?` Получено: ${item.actual}.`:''}`)].join('\n'),t.actual??''].map(csv).join(';'))].join('\r\n'),{mode:0o600});
  const names=['original-results.zip','assessment.json','assessment.html','assessment.csv'];
  const sums={}; for (const n of names) sums[n]=await hashFile(path.join(dir,n));
  await json(path.join(dir,'SHA256.json'),sums);
  await writeZip([...names,'SHA256.json'].map(name=>({name,file:path.join(dir,name)})),path.join(dir,'reviewed-results.zip'));
  return assessment;
}
module.exports={gradingContext,contextMatches,importResult,reviewView,writeReviewReport,labels};
