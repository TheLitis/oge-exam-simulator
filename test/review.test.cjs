'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {fsp,path,JSZip,hashFile}=require('../src/io.cjs');
const {ExamService}=require('../src/service.cjs');
const {startServer}=require('../src/server.cjs');
const {importResult}=require('../src/review.cjs');
const PERSON={registration:'00000991',surname:'Тестовый',name:'Ученик',passportSeries:'0000',passportNumber:'000000'};
const DEMO=path.join(__dirname,'../examples/demo.oge');
const short={type:'short',answers:['160'],caseSensitive:true,ignoreWhitespace:false};
async function context(t) {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-review-')); t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  let executions=0; const requests=[];
  const codeRunner={capabilities:async()=>({available:true,languages:{python:true,javascript:true}}),runCode:async options=>{
    executions++; requests.push(options); return {status:'ok',stdout:'42\n',stderr:'',exitCode:0,signal:null,durationMs:2};
  }};
  const s=new ExamService(root,{codeRunner}); await s.init(); await s.importExam(DEMO,true);
  await s.setEditorChecker({taskId:1,checker:short});
  return {s,root,requests,executions:()=>executions};
}
async function completed(t) {
  const c=await context(t), {s}=c;
  await s.setEditorChecker({taskId:13,checker:{type:'text',expected:'42',comparison:'trim',caseSensitive:true}});
  await s.setEditorChecker({taskId:16,checker:{type:'code',language:'python',comparison:'trim',tests:[{input:'',expected:'42'},{input:'',expected:'43'}]}});
  const exported=await s.exportExam(true); await s.importExam(s.exportFile(exported.id)); await s.start(PERSON,'DEMO-2026');
  await s.saveAnswer(1,' 160 '); await s.saveDraft(2,'42');
  for (const [id,name,source] of [[13,'answer.txt','42\n'],[16,'answer.py','print(42)']]) {
    const file=path.join(c.root,name); await fsp.writeFile(file,source); await s.attachFile(id,file,name); await s.saveAnswer(id);
  }
  await s.finish(); return c;
}
test('project keeps optional keys, published exam strips them, pupil API never exposes them',async t=>{
  const {s,root}=await context(t), project=await s.exportExam(false), exam=await s.exportExam(true);
  const p=await JSZip.loadAsync(await fsp.readFile(s.exportFile(project.id))), e=await JSZip.loadAsync(await fsp.readFile(s.exportFile(exam.id)));
  assert.deepEqual(JSON.parse(await p.file('manifest.json').async('string')).tasks[0].checker,short);
  assert.equal(JSON.parse(await e.file('manifest.json').async('string')).tasks.some(t=>Object.hasOwn(t,'checker')),false);
  await s.importExam(s.exportFile(exam.id)); await s.start(PERSON,'DEMO-2026');
  assert.equal(s.state().editor,null); assert.equal(JSON.stringify(s.state().exam).includes('checker'),false);
  assert.equal(JSON.stringify(s.task(1)).includes('checker'),false);
  await assert.rejects(s.setEditorChecker({taskId:1,checker:short}));
  await assert.rejects(s.importReview(DEMO));
  await s.finish(); await s.dismissResult();
  const restored=new ExamService(root,{codeRunner:s.codeRunner}); await restored.init();
  assert.deepEqual(restored.state({teacherAccess:true}).editor.tasks[0].checker,short);
});
test('teacher review checks submitted answers, distinguishes drafts, runs code only on explicit review, exports verified ZIP',async t=>{
  const {s,executions,requests}=await completed(t), source=s.attempt.archivePath, sourceHash=await hashFile(source);
  assert.equal(executions(),0);
  const review=await s.importReview(source); assert.equal(review.contextMatch,true); assert.equal(review.savedCount,3); assert.equal(review.draftCount,1);
  assert.equal(review.attempt,undefined); assert.equal(executions(),0);
  const grade=await s.checkReview({id:review.id});
  assert.equal(grade.tasks[0].status,'correct'); assert.equal(grade.tasks[1].status,'unanswered');
  assert.equal(grade.tasks[12].status,'correct'); assert.equal(grade.tasks[15].status,'incorrect',JSON.stringify(grade.tasks[15]));
  assert.equal(grade.tasks[15].tests.length,2); assert.equal(executions(),2);
  for (const options of requests) { assert.equal(options.language,'python'); assert.match(options.source.toString(),/print/); assert.equal(Object.hasOwn(options,'expected'),false); }
  assert.equal(grade.summary.correct,2); assert.equal(grade.summary.incorrect,1);
  assert.equal(await hashFile(source),sourceHash);
  const report=await JSZip.loadAsync(await fsp.readFile(await s.reviewReport(review.id))), sums=JSON.parse(await report.file('SHA256.json').async('string'));
  assert.equal(Object.keys(sums).length,4);
  const crypto=require('node:crypto');
  for(const [name,hash] of Object.entries(sums)) assert.equal(crypto.createHash('sha256').update(await report.file(name).async('nodebuffer')).digest('hex'),hash);
  assert.equal(crypto.createHash('sha256').update(await report.file('original-results.zip').async('nodebuffer')).digest('hex'),sourceHash);
  assert.match(await report.file('assessment.html').async('string'),/Верно/);
  assert.match(await report.file('assessment.html').async('string'),/Тест 2: Неверно/);
  assert.match(await report.file('assessment.html').async('string'),/Получено:<br>42/);
});
test('different project requires explicit matching decision and unavailable runtime is not an incorrect answer',async t=>{
  const {s}=await completed(t), review=await s.importReview(s.attempt.archivePath);
  await s.newEditor(); await s.setEditorChecker({taskId:16,checker:{type:'code',language:'python',tests:[{input:'',expected:'42'}]}});
  await assert.rejects(s.checkReview({id:review.id}),/Сопоставьте/);
  s.codeRunner.runCode=async()=>({status:'unavailable',message:'Sandbox unavailable'});
  const a=await s.checkReview({id:review.id,allowUnmatched:true}); assert.equal(a.tasks[15].status,'unavailable'); assert.equal(a.summary.incorrect,0);
  assert.equal((await s.loadReview(review.id)).contextMatch,false);
});
test('old result ZIP without context remains readable with explicit teacher confirmation',async t=>{
  const {s,root}=await completed(t), zip=await JSZip.loadAsync(await fsp.readFile(s.attempt.archivePath));
  zip.remove('grading-context.json'); const sums=JSON.parse(await zip.file('SHA256.json').async('string')); delete sums['grading-context.json']; zip.file('SHA256.json',JSON.stringify(sums));
  const old=path.join(root,'old.zip'); await fsp.writeFile(old,await zip.generateAsync({type:'nodebuffer'}));
  const review=await s.importReview(old); assert.equal(review.contextMatch,null); await assert.rejects(s.checkReview({id:review.id}));
  assert.equal((await s.checkReview({id:review.id,allowUnmatched:true})).tasks[0].status,'correct');
});
test('ordinary result ZIP comments are rejected without running submitted code',async t=>{
  const {s,root,executions}=await completed(t), zip=await JSZip.loadAsync(await fsp.readFile(s.attempt.archivePath));
  const file=path.join(root,'commented-result.zip');
  await fsp.writeFile(file,await zip.generateAsync({type:'nodebuffer',comment:'An ordinary archive note'}));
  await assert.rejects(s.importReview(file),/Комментарии ZIP/); assert.equal(executions(),0);
});
test('corrupted, unhashed and duplicate result archives are rejected before code runs',async t=>{
  const {s,root,executions}=await completed(t);
  for (const variant of ['corrupt','unhashed','wrongSaved']) {
    const zip=await JSZip.loadAsync(await fsp.readFile(s.attempt.archivePath));
    if(variant==='corrupt') zip.file('files/task-16/answer.py','print(999)');
    if(variant==='unhashed') zip.file('extra.txt','x');
    if(variant==='wrongSaved') {
      const answers=JSON.parse(await zip.file('answers.json').async('string')); answers.answers[0].saved='yes';
      const text=JSON.stringify(answers), sums=JSON.parse(await zip.file('SHA256.json').async('string')); sums['answers.json']=require('node:crypto').createHash('sha256').update(text).digest('hex');
      zip.file('answers.json',text); zip.file('SHA256.json',JSON.stringify(sums));
    }
    const file=path.join(root,variant+'.zip'); await fsp.writeFile(file,await zip.generateAsync({type:'nodebuffer'})); await assert.rejects(s.importReview(file));
  }
  assert.equal(executions(),0);
  const zip=new JSZip(); zip.file('../answers.json','{}',{createFolders:false}); zip.file('SHA256.json','{}');
  const file=path.join(root,'traversal.zip'); await fsp.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  await assert.rejects(importResult(file,s.dir('reviews'),s.editor));
});
test('HTTP teacher checker/review routes require auth, reject active sessions and support check/report round trip',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-review-http-')), app=await startServer({root,open:false,lock:false});
  t.after(async()=>{await app.close();await fsp.rm(root,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${app.key}`}, post=async(route,data)=>{
    const r=await fetch(app.url+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};
  };
  assert.equal((await fetch(app.url+'/api/editor/checker',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const access=await post('/api/teacher/setup',{password:'Review teacher password 2026'});
  assert.equal(access.status,200); headers['X-Teacher-Token']=access.body.value.token;
  assert.equal((await post('/api/demo',{edit:true})).status,200);
  assert.equal((await post('/api/editor/checker',{taskId:1,checker:short})).status,200);
  assert.equal((await post('/api/editor/checker',{taskId:1,checker:{type:'code',language:'python',tests:[]}})).status,400);
  await post('/api/demo',{});await post('/api/start',{candidate:PERSON,code:'DEMO-2026'});
  assert.equal((await post('/api/editor/checker',{taskId:1,checker:short})).status,403);
  await post('/api/save',{id:1,text:'160'});await post('/api/finish',{confirm:true});
  const reopened=await post('/api/teacher/unlock',{password:'Review teacher password 2026'});
  assert.equal(reopened.status,200); headers['X-Teacher-Token']=reopened.body.value.token;
  const r=await fetch(app.url+'/api/upload?kind=review&name=result.zip',{method:'POST',headers,body:await fsp.readFile(app.service.attempt.archivePath)});
  assert.equal(r.status,200);const review=(await r.json()).value;
  const grade=await post('/api/review/check',{id:review.id});assert.equal(grade.status,200);assert.equal(grade.body.value.tasks[0].status,'correct');
  assert.equal((await fetch(app.url+'/api/review/report?id='+review.id,{headers})).status,200);
  assert.equal((await fetch(app.url+'/api/review/report?id=..',{headers})).status,400);
});
