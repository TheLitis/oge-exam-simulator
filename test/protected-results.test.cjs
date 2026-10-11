'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {fsp,path,crypto,JSZip,hashFile,readJson}=require('../src/io.cjs');
const {ExamService}=require('../src/service.cjs');
const {startServer}=require('../src/server.cjs');
const P=require('../src/result-protection.cjs');
const S=require('../src/result-storage.cjs');
const {isProtectedProject}=require('../src/teacher.cjs');
const DEMO=path.join(__dirname,'../examples/demo.oge');
const PASSWORD='Synthetic protected results teacher password';
const PERSON={registration:'876543210987',surname:'Конфиденциальный',name:'Ученик',passportSeries:'0000',passportNumber:'000000'};
const ANSWER='PRIVATE-STUDENT-ANSWER-67CB';
async function setup(t) {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-protected-results-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const clock={now:()=>Date.UTC(2026,9,11,10),monotonic:()=>0};
  let runs=0;
  const codeRunner={capabilities:async()=>({available:true,languages:{python:true,javascript:true}}),runCode:async()=>{runs++;return {status:'ok',stdout:'42\n',stderr:'',exitCode:0,durationMs:1};}};
  const teacher=new ExamService(path.join(root,'teacher-data'),{...clock,codeRunner});await teacher.init();await teacher.configureTeacher(PASSWORD);
  await teacher.importExam(DEMO,true);
  await teacher.setEditorChecker({taskId:1,checker:{type:'short',answers:[ANSWER],caseSensitive:true,ignoreWhitespace:false}});
  await teacher.setEditorChecker({taskId:13,checker:{type:'text',expected:ANSWER,comparison:'trim',caseSensitive:true}});
  await teacher.setEditorChecker({taskId:16,checker:{type:'code',language:'javascript',reference:{language:'python',source:'print(42)'},tests:[{input:'20\n22\n'}]}});
  const published=await teacher.exportExam(true),file=teacher.exportFile(published.id);
  const pupilRoot=path.join(root,'pupil-data'),resultsRoot=path.join(root,'Документы','Результаты');
  const pupil=new ExamService(pupilRoot,{...clock,resultsRoot,codeRunner});await pupil.init();await pupil.importExam(file);
  await pupil.start(PERSON,'DEMO-2026');
  return {root,teacher,pupil,pupilRoot,resultsRoot,clock,codeRunner,file,runs:()=>runs};
}
async function complete(c) {
  const {pupil,root}=c;
  for(let id=1;id<=12;id++)await pupil.saveAnswer(id,id===1?ANSWER:String(id));
  await pupil.saveDraft(2,'PRIVATE-UNSUBMITTED-DRAFT');
  for(let id=13;id<=16;id++) {
    const file=path.join(root,`upload-${id}.txt`);await fsp.writeFile(file,id===16?'console.log(42)':ANSWER);
    await pupil.attachFile(id,file,id===16?'answer.js':`answer-${id}.txt`);await pupil.saveAnswer(id);
  }
  await pupil.finish();assert.equal(pupil.sessionView().encrypted,true);assert.equal(pupil.sessionView().archiveReady,true);
}
async function allFiles(root) {
  const files=[];
  async function walk(dir){for(const e of await fsp.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(e.isFile())files.push(f);}}
  await walk(root);return files;
}
async function unlocked(c){if(!c.teacher.teacher.unlocked())await c.teacher.unlockTeacher(PASSWORD);}
async function decrypt(c,file,out=path.join(c.root,'decrypted-result.zip')) {await unlocked(c);await P.decryptFile(file,out,c.teacher.teacher.resultPrivateKeys());return JSZip.loadAsync(await fsp.readFile(out));}

test('production defaults require a teacher recipient and publish only its public key',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-recipient-required-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const s=new ExamService(root);await s.init();await s.importExam(DEMO);
  await assert.rejects(s.start(PERSON,'DEMO-2026'),/ключа результатов/);
  await s.importExam(DEMO,true);await assert.rejects(s.exportExam(true),/пароль учителя/);
  await s.configureTeacher(PASSWORD);const exported=await s.exportExam(true);
  const zip=await JSZip.loadAsync(await fsp.readFile(s.exportFile(exported.id))),raw=await zip.file('manifest.json').async('string'),manifest=JSON.parse(raw);
  assert.equal(manifest.resultRecipient.keyId,s.teacher.resultRecipient().keyId);
  assert.match(manifest.resultRecipient.publicKey,/BEGIN PUBLIC KEY/);
  assert.equal(raw.includes('PRIVATE KEY'),false);assert.equal(raw.includes(PASSWORD),false);assert.equal(raw.includes('checker'),false);
});

test('ordinary pupil completes all 16 tasks; finalized visible and hidden copies contain no plaintext data',async t=>{
  const c=await setup(t);assert.equal(c.pupil.teacherConfigured(),false);await complete(c);
  assert.equal(c.pupil.sessionView().savedCount,16);assert.equal(c.pupil.sessionView().dirtyCount,1);assert.equal(c.runs(),0);
  const session=path.join(c.pupilRoot,'sessions',c.pupil.attempt.id);
  assert.deepEqual((await fsp.readdir(session)).sort(),['exam','receipt.json','result.ogeresult']);
  const visible=c.pupil.attempt.archivePath;assert.equal(await P.isEncryptedResult(visible),true);assert.equal(visible.includes(PERSON.registration),false);
  for(const file of await allFiles(c.pupilRoot)) {
    const data=await fsp.readFile(file);for(const marker of [ANSWER,PERSON.surname,PERSON.registration,'PRIVATE-UNSUBMITTED-DRAFT'])assert.equal(data.includes(Buffer.from(marker)),false,file);
  }
  const zip=await decrypt(c,visible),sums=JSON.parse(await zip.file('SHA256.json').async('string'));
  for(const [name,sha]of Object.entries(sums))assert.equal(crypto.createHash('sha256').update(await zip.file(name).async('nodebuffer')).digest('hex'),sha,name);
  assert.equal(JSON.parse(await zip.file('candidate.json').async('string')).registration,PERSON.registration);
  assert.equal(JSON.parse(await zip.file('answers.json').async('string')).answers[0].answer,ANSWER);
  assert.equal(JSON.parse(await zip.file('drafts.json').async('string')).drafts['2'].text,'PRIVATE-UNSUBMITTED-DRAFT');
});

test('restart without teacher/private key preserves active answers and restores deleted finalized archives byte for byte',async t=>{
  const c=await setup(t);await c.pupil.saveAnswer(1,ANSWER);
  const resumed=new ExamService(c.pupilRoot,{...c.clock,resultsRoot:c.resultsRoot,codeRunner:c.codeRunner});await resumed.init();
  assert.equal(resumed.sessionView().recovered,true);assert.equal(resumed.task(1).savedText,ANSWER);c.pupil=resumed;
  await complete(c);const original=resumed.attempt.archivePath,hash=await hashFile(original);await fsp.unlink(original);
  const finished=new ExamService(c.pupilRoot,{...c.clock,resultsRoot:c.resultsRoot,codeRunner:c.codeRunner});await finished.init();
  assert.equal(finished.teacherConfigured(),false);assert.equal(finished.sessionView().archiveReady,true);assert.equal(finished.attempt.archivePath,original);
  assert.equal(await hashFile(original),hash);assert.equal(await hashFile((await finished.resultDownload()).file),hash);
  assert.throws(()=>finished.task(1),/Сеанс завершён/);
});

test('dismissed finalized backups also restore and changed visible files never overwrite another file',async t=>{
  const c=await setup(t);await complete(c);const original=c.pupil.attempt.archivePath,hash=await hashFile(original);
  await fsp.writeFile(original,'UNEXPECTED-EXISTING-CONTENT');await c.pupil.exportResults();
  assert.notEqual(c.pupil.attempt.archivePath,original);assert.equal(await fsp.readFile(original,'utf8'),'UNEXPECTED-EXISTING-CONTENT');
  assert.equal(await hashFile(c.pupil.attempt.archivePath),hash);
  const restoredPath=c.pupil.attempt.archivePath;await c.pupil.dismissResult();await fsp.unlink(restoredPath);
  const reopened=new ExamService(c.pupilRoot,{...c.clock,resultsRoot:c.resultsRoot,codeRunner:c.codeRunner});await reopened.init();
  assert.equal(reopened.attempt,null);assert.equal(await hashFile(restoredPath),hash);
});

test('unavailable Documents and an interrupted cleanup remain retriable from the protected backup',async t=>{
  const c=await setup(t);const blocked=path.join(c.root,'blocked');await fsp.writeFile(blocked,'file');c.pupil.resultsRoot=path.join(blocked,'Результаты');
  await c.pupil.saveAnswer(1,ANSWER);await c.pupil.finish();
  assert.equal(c.pupil.attempt.sealed,true);assert.equal(c.pupil.sessionView().archiveReady,false);assert.ok(c.pupil.sessionView().exportError);
  assert.equal(await P.isEncryptedResult(path.join(c.pupil.attemptDir(),'result.ogeresult')),true);
  await fsp.unlink(blocked);await c.pupil.exportResults();assert.equal(c.pupil.sessionView().archiveReady,true);
  // A simulated crash left old checkpoint/blobs beside a valid durable receipt.
  const dir=c.pupil.attemptDir();await fsp.writeFile(path.join(dir,'session.json.bak'),ANSWER);await fsp.mkdir(path.join(dir,'blobs'));await fsp.writeFile(path.join(dir,'blobs','orphan'),ANSWER);
  const restart=new ExamService(c.pupilRoot,{...c.clock,resultsRoot:c.pupil.resultsRoot,codeRunner:c.codeRunner});await restart.init();
  assert.equal(await fsp.stat(path.join(dir,'session.json.bak')).then(()=>true,()=>false),false);
  assert.equal(await fsp.stat(path.join(dir,'blobs')).then(()=>true,()=>false),false);
});

test('corrupt backup refuses cleanup and preserves existing recovery data',async t=>{
  const c=await setup(t);await complete(c);const dir=c.pupil.attemptDir(),backup=path.join(dir,'result.ogeresult');
  const data=await fsp.readFile(backup);data[data.length-1]^=1;await fsp.writeFile(backup,data);
  await fsp.writeFile(path.join(dir,'session.json.bak'),ANSWER);
  await assert.rejects(S.readReceipt(dir,c.pupil.attempt.id),/повреждена/);
  const restart=new ExamService(c.pupilRoot,{...c.clock,resultsRoot:c.resultsRoot});await restart.init();
  assert.equal(await fsp.readFile(path.join(dir,'session.json.bak'),'utf8'),ANSWER);assert.match(restart.state().warning,/повреждённый/);
});

test('encrypted imported source is sole grading input; persistent review copies are encrypted and report is explicit plaintext export',async t=>{
  const c=await setup(t);await complete(c);const source=c.pupil.attempt.archivePath,view=await c.teacher.importReview(source);
  assert.equal(view.contextMatch,true);assert.equal(view.savedCount,16);assert.equal(view.draftCount,1);assert.equal(view.sourceEncrypted,true);
  const reviewDir=c.teacher.dir('reviews',view.id);
  for(const file of await allFiles(reviewDir))assert.equal(await isProtectedProject(file),true,file);
  await fsp.writeFile(source,'changed after import');
  const assessment=await c.teacher.checkReview({id:view.id});assert.equal(assessment.tasks[0].status,'correct');assert.equal(assessment.tasks[12].status,'correct');assert.equal(assessment.tasks[15].status,'correct');assert.equal(c.runs(),2);
  for(const file of await allFiles(reviewDir)) {
    assert.equal(await isProtectedProject(file),true,file);assert.equal((await fsp.readFile(file)).includes(Buffer.from(ANSWER)),false,file);
  }
  const report=await c.teacher.reviewReport(view.id),zip=await JSZip.loadAsync(await fsp.readFile(report.file));
  assert.equal(JSON.parse(await zip.file('assessment.json').async('string')).assessment.projectSha256,assessment.projectSha256);await report.cleanup();
  await c.teacher.lockTeacher();assert.deepEqual(await fsp.readdir(c.teacher.dir('teacher/runtime')),[]);
});

test('tampered and foreign-key work imports do not run code or leave plaintext; backup key makes another teacher able to grade',async t=>{
  const c=await setup(t);await complete(c);const other=new ExamService(path.join(c.root,'other-teacher'),c.clock);await other.init();await other.configureTeacher('Other synthetic teacher password');
  await other.importExam(DEMO,true);const work=c.pupil.attempt.archivePath;
  await assert.rejects(other.importReview(work),e=>e.code==='RESULT_KEY_REQUIRED');assert.deepEqual(await fsp.readdir(other.dir('teacher/runtime')),[]);assert.equal(c.runs(),0);
  await assert.rejects(other.importResultKey(c.teacher.resultKeyBackup()),e=>e.code==='RESULT_KEY_PASSWORD_REQUIRED');
  await assert.rejects(other.importResultKey(c.teacher.resultKeyBackup(),'Wrong synthetic password'),e=>e.code==='RESULT_KEY_PASSWORD_INVALID');assert.equal(other.teacher.unlocked(),true);
  const ownId=other.teacher.resultRecipient().keyId;assert.equal((await other.importResultKey(c.teacher.resultKeyBackup(),PASSWORD)).imported,1);assert.equal(other.teacher.resultRecipient().keyId,ownId);
  assert.equal((await other.importReview(work)).savedCount,16);
  const damaged=path.join(c.root,'damaged.ogeresult'),bytes=await fsp.readFile(work);bytes[bytes.length-1]^=1;await fsp.writeFile(damaged,bytes);
  await assert.rejects(c.teacher.importReview(damaged),e=>e.code==='RESULT_INVALID');assert.deepEqual(await fsp.readdir(c.teacher.dir('teacher/runtime')),[]);assert.equal(c.runs(),0);
});

test('teacher unlock migrates old ZIPs, unpacked and orphan folders, finished sessions and imported reviews without changing external copies',async t=>{
  const {ExamService:LegacyService}=require('./helpers/legacy-service.cjs');
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-protected-migration-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const s=new LegacyService(path.join(root,'data'));await s.init();await s.importExam(DEMO,true);
  await s.setEditorChecker({taskId:1,checker:{type:'short',answers:[ANSWER],caseSensitive:true,ignoreWhitespace:false}});
  const published=await s.exportExam(true);await s.importExam(s.exportFile(published.id));await s.start(PERSON,'DEMO-2026');await s.saveAnswer(1,ANSWER);await s.finish();
  const oldZip=s.attempt.archivePath,oldFolder=s.attempt.resultDir,originalHash=await hashFile(oldZip),external=path.join(root,'external.zip');await fsp.copyFile(oldZip,external);
  const review=await s.importReview(oldZip),visible=path.join(root,'visible');await fsp.mkdir(visible);await fsp.copyFile(oldZip,path.join(visible,path.basename(oldZip)));await fsp.cp(oldFolder,path.join(visible,path.basename(oldFolder)),{recursive:true});
  const orphan=path.join(visible,'OGE_orphan');await fsp.cp(oldFolder,orphan,{recursive:true});
  s.resultsRoot=visible;await s.configureTeacher(PASSWORD);
  assert.equal(s.config.resultsProtection,1);assert.equal(await hashFile(external),originalHash);
  for(const f of await allFiles(s.root)){const b=await fsp.readFile(f);assert.equal(b.includes(Buffer.from(ANSWER)),false,f);assert.equal(b.includes(Buffer.from(PERSON.surname)),false,f);}
  assert.equal(await fsp.stat(oldZip).then(()=>true,()=>false),false);assert.equal(await fsp.stat(oldFolder).then(()=>true,()=>false),false);assert.equal(await fsp.stat(orphan).then(()=>true,()=>false),false);
  assert.equal((await s.checkReview({id:review.id})).tasks[0].status,'correct');
  const encrypted=s.attempt.archivePath;const plain=path.join(root,'restored.zip');await P.decryptFile(encrypted,plain,s.teacher.resultPrivateKeys());assert.equal(await hashFile(plain),originalHash);
});

test('default HTTP accepts public-key pupil work without teacher login and gates key backups and review imports',async t=>{
  const c=await setup(t),app=await startServer({root:path.join(c.root,'http-pupil'),open:false,lock:false,folderLauncher:async()=>{}});t.after(()=>app.close());
  const headers={Authorization:`Bearer ${app.key}`,'Content-Type':'application/json'};
  const call=(route,body)=>fetch(app.url+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await call('/api/teacher/result-key')).status,403);
  assert.equal((await call('/api/open-folder',{root:true})).status,200);
  const upload=await fetch(app.url+'/api/upload?kind=package&name=exam.oge',{method:'POST',headers:{Authorization:headers.Authorization},body:await fsp.readFile(c.file)});assert.equal(upload.status,200);
  assert.equal((await call('/api/start',{candidate:PERSON,code:'DEMO-2026'})).status,200);
  assert.equal((await call('/api/save',{id:1,text:ANSWER})).status,200);assert.equal((await call('/api/finish',{confirm:true})).status,200);
  const result=await call('/api/result');assert.equal(result.status,200);assert.match(result.headers.get('content-disposition'),/ogeresult/);assert.equal(result.headers.get('content-type'),'application/octet-stream');
  assert.equal(Buffer.from(await result.arrayBuffer()).subarray(0,14).toString(),'OGE-RESULT-V1\n');
});
