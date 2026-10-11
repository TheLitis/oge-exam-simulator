'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { Readable } = require('node:stream');
const I = require('../src/io.cjs');
const M = require('../src/model.cjs');
const { ExamService, csv, html } = require('./helpers/legacy-service.cjs');
const { fsp, path, JSZip } = I;
const DEMO = path.join(__dirname, '../examples/demo.oge');
const IMAGE = path.join(__dirname, '../examples/images/1.1.png');
// Synthetic registration details, not a real person's passport.
const PERSON = { registration:'00012345', surname:'Тестовый', name:'Ученик', passportSeries:'0000', passportNumber:'000000' };
async function context(t, active = true) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-test-'));
  t.after(() => fsp.rm(root, { recursive:true, force:true }));
  const time = { wall:Date.UTC(2026, 9, 9, 8), mono:0 };
  const clock = { now:() => time.wall, monotonic:() => time.mono };
  const s = new ExamService(root, clock); await s.init();
  if (active) { await s.importExam(DEMO); await s.start(PERSON, 'DEMO-2026'); }
  return { s, root, time, clock, advance(ms) { time.wall += ms; time.mono += ms; } };
}
async function zipData(entries, opts = {}) {
  const zip = new JSZip();
  for (const [name, data, options] of entries) zip.file(name, data, { createFolders:false, ...options });
  return zip.generateAsync({ type:'nodebuffer', platform:'UNIX', ...opts });
}

test('new results use a visible directory and survive restart without a second ZIP', async t => {
  const { root, clock } = await context(t, false);
  const resultsRoot = path.join(root, 'Документы', 'Симулятор экзамена', 'Результаты');
  const s = new ExamService(root, { ...clock, resultsRoot }); await s.init();
  await s.importExam(DEMO); await s.start(PERSON, 'DEMO-2026');
  await s.saveAnswer(1, '42'); await s.saveDraft(2, 'черновик'); await s.finish();
  assert.equal(s.state().resultsRoot, resultsRoot);
  assert.equal(path.dirname(s.attempt.resultDir), resultsRoot);
  const archive = s.attempt.archivePath, originalHash = await I.hashFile(archive);
  const zip = await JSZip.loadAsync(await fsp.readFile(archive));
  assert.equal(JSON.parse(await zip.file('answers.json').async('string')).answers[0].answer, '42');
  assert.equal(JSON.parse(await zip.file('drafts.json').async('string')).drafts['2'].text, 'черновик');
  const restored = new ExamService(root, { ...clock, resultsRoot }); await restored.init();
  assert.equal(restored.attempt.archivePath, archive);
  assert.equal(await I.hashFile(archive), originalHash);
  assert.equal((await fsp.readdir(resultsRoot)).length, 2);
  assert.deepEqual(await fsp.readdir(path.join(root, 'results')), []);
});

test('all finished sessions including dismissed results migrate with their original archive bytes', async t => {
  const { s, root, clock } = await context(t);
  await s.setTheme('dark'); await s.saveAnswer(1, '42'); await s.finish();
  const first = structuredClone(s.attempt);
  await s.dismissResult(); await s.start(PERSON, 'DEMO-2026'); await s.finish();
  const second = structuredClone(s.attempt);
  const hashes = await Promise.all([first, second].map(a => I.hashFile(a.archivePath)));
  const resultsRoot = path.join(root, 'Документы', 'Симулятор экзамена', 'Результаты');
  const restored = new ExamService(root, { ...clock, resultsRoot }); await restored.init();
  assert.equal(restored.theme(), 'dark'); assert.equal(restored.attempt.id, second.id);
  for (const [index, original] of [first, second].entries()) {
    const session = await I.readJson(path.join(root, 'sessions', original.id, 'session.json'));
    assert.equal(path.dirname(session.resultDir), resultsRoot);
    assert.equal(path.dirname(session.archivePath), resultsRoot);
    assert.equal(await I.hashFile(session.archivePath), hashes[index]);
    assert.equal(await I.hashFile(original.archivePath), hashes[index]);
    const expected = { ...original, resultDir:session.resultDir, archivePath:session.archivePath };
    assert.deepEqual(session, expected);
  }
  const again = new ExamService(root, { ...clock, resultsRoot }); await again.init();
  assert.equal((await fsp.readdir(resultsRoot)).length, 4);
  assert.equal(again.attempt.archivePath, restored.attempt.archivePath);
});

test('unavailable visible folder preserves legacy results and pending exports can be retried', async t => {
  const { s, root, clock } = await context(t);
  await s.saveAnswer(1, '42'); await s.finish();
  const original = structuredClone(s.attempt), hash = await I.hashFile(original.archivePath);
  const blocked = path.join(root, 'blocked'); await fsp.writeFile(blocked, 'file');
  const resultsRoot = path.join(blocked, 'Результаты');
  const restored = new ExamService(root, { ...clock, resultsRoot }); await restored.init();
  assert.match(restored.state().warning, /Оригиналы сохранены/);
  assert.equal(restored.attempt.archivePath, original.archivePath);
  assert.equal(await I.hashFile(original.archivePath), hash);
  await restored.dismissResult(); await restored.start(PERSON, 'DEMO-2026');
  await restored.saveAnswer(1, '84'); await restored.finish();
  assert.equal(restored.attempt.status, 'finished'); assert.equal(restored.sessionView().archiveReady, false);
  await fsp.unlink(blocked); await fsp.mkdir(blocked);
  await restored.exportResults();
  assert.equal(restored.sessionView().archiveReady, true);
  assert.equal(path.dirname(restored.attempt.archivePath), resultsRoot);
  assert.equal(restored.attempt.answers[1].text, '84');
  assert.equal(await I.hashFile(original.archivePath), hash);
});

test('16 tasks, exact duration and fixed answer/resource matrix', () => {
  const e = M.blankExam(); assert.equal(e.tasks.length,16); assert.equal(e.durationSeconds,9000);
  for (let id = 1; id <= 16; id++) { assert.equal(M.taskKind(id), id<=12?'short':'file'); assert.equal(M.hasResources(id), id>=11&&id<=16); assert.equal(M.requiresResources(id), id>=11&&id<=14); }
  for (const id of [0,17,1.5,'2',null]) assert.throws(() => M.taskKind(id));
});
test('image parser accepts valid names and rejects out-of-range/malformed names', () => {
  assert.deepEqual(M.parseImageName('16.02.PNG'), { taskId:16, image:'02', ext:'png' });
  for (const n of ['0.1.png','17.1.png','1.png','1.2.svg','text.1.png','../1.1.png']) assert.equal(M.parseImageName(n),null);
});
test('sorting is lexical, not natural or numeric', () => {
  assert.deepEqual(['1.2.png','1.10.png','1.1.png'].map(name=>({name})).sort(M.lexical).map(a=>a.name), ['1.1.png','1.10.png','1.2.png']);
});
test('required registration fields and leading zeros', () => {
  assert.equal(M.candidate(PERSON).registration,'00012345');
  for (const field of Object.keys(PERSON)) assert.throws(() => M.candidate({...PERSON,[field]:''}));
  assert.throws(()=>M.candidate({...PERSON,passportSeries:'123'}));
  assert.throws(()=>M.candidate({...PERSON,surname:'<script>'}));
});
test('activation is salted scrypt; no plaintext code and wrong/missing code fails', async () => {
  const a = await M.activation('correct-code'); const b = await M.activation('correct-code');
  assert.notEqual(a.hash,b.hash); assert.equal(JSON.stringify(a).includes('correct-code'),false);
  assert.equal(await M.verifyCode('correct-code',a),true);
  assert.equal(await M.verifyCode('wrong-code',a),false); assert.equal(await M.verifyCode(undefined,a),false);
  await assert.rejects(M.activation('123'));
});
test('invalid task count, timer changes and incomplete publication are rejected', () => {
  assert.throws(()=>M.validateShape({...M.blankExam(),durationSeconds:30}));
  assert.throws(()=>M.validateShape({...M.blankExam(),tasks:[]}));
  assert.throws(()=>M.validateShape({...M.blankExam(),published:true}));
  assert.throws(()=>M.validateShape(M.blankExam(),true));
});
test('safe filenames reject traversal, controls, reserved and executable markup', () => {
  for (const n of ['../x','x/y','x\\y','NUL.txt','.hidden','a\n.txt','a:ads','<img>.png']) assert.throws(()=>I.safeName(n));
  assert.equal(I.safeName('Мой ответ.py'),'Мой ответ.py');
  assert.throws(()=>I.safeRelative('assets/../../etc/passwd'));
  assert.throws(()=>I.inside('/tmp/project','../outside'));
  assert.throws(()=>I.rasterMime(Buffer.from('<svg><script/>'),'svg'));
});
test('atomic writes keep readable backup; corrupt primary can be restored', async t => {
  const {root} = await context(t,false); const file=path.join(root,'atomic.json');
  await I.json(file,{v:1},true); await I.json(file,{v:2},true);
  assert.equal((await I.readJson(file)).v,2); assert.equal((await I.readJson(file+'.bak')).v,1);
  await fsp.writeFile(file,'broken'); assert.equal((await I.readJson(file,true)).v,1);
});
test('bounded copy rejects excess bytes and removes partial file', async t => {
  const {root}=await context(t,false); const target=path.join(root,'partial');
  await assert.rejects(I.boundedCopy(Readable.from(Buffer.alloc(20)),target,10));
  await assert.rejects(fsp.access(target));
});
test('demo package imports, all assets match SHA256 and public state hides secrets', async t => {
  const {s}=await context(t,false); const e=await s.importExam(DEMO);
  assert.equal(e.tasks.length,16); assert.equal(e.tasks[2].images.length,2);
  await M.validateFiles(s.exam,s.examDir,true);
  assert.equal(JSON.stringify(s.state()).includes('"hash"'),false);
  assert.equal(JSON.stringify(s.state()).includes('DEMO-2026'),false);
});
test('generated package roundtrip uses one comment-free ZIP directory', async t => {
  const {root}=await context(t,false); const file=path.join(root,'roundtrip.oge'), dest=path.join(root,'unpack');
  await I.writeZip([{name:'manifest.json',data:'{"title":"Тест"}'}],file);
  const data=await fsp.readFile(file); assert.deepEqual(I.preflightZip(data),[{name:'manifest.json',size:Buffer.byteLength('{"title":"Тест"}') }]);
  assert.deepEqual(await I.extractPackage(file,dest),{title:'Тест'});
});
test('ordinary ZIP comments are rejected before package extraction', async t => {
  const {root}=await context(t,false); const file=path.join(root,'comment.oge'), dest=path.join(root,'unpack');
  const data=await zipData([['manifest.json','{}']],{comment:'An ordinary archive note'});
  assert.throws(()=>I.preflightZip(data),/Комментарии ZIP/);
  await fsp.writeFile(file,data); await assert.rejects(I.extractPackage(file,dest),/Комментарии ZIP/);
  await assert.rejects(fsp.access(dest));
});
test('package path traversal is rejected before extraction', async t => {
  const {root}=await context(t,false); const file=path.join(root,'evil.zip');
  await fsp.writeFile(file,await zipData([['manifest.json','{}'],['../escape','no']]));
  await assert.rejects(I.extractPackage(file,path.join(root,'unpack')));
  await assert.rejects(fsp.access(path.join(root,'escape')));
});
test('package symlinks are rejected', async () => {
  const data=await zipData([['manifest.json','{}',{unixPermissions:0o120777}]]);
  assert.throws(()=>I.preflightZip(data));
});
test('forged uncompressed sizes and encrypted flags are rejected before inflate', async () => {
  const source=await zipData([['manifest.json','{}']]); const pos=source.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  const a=Buffer.from(source); a.writeUInt32LE(I.LIMITS.json+1,pos+24); assert.throws(()=>I.preflightZip(a));
  const b=Buffer.from(source); b.writeUInt16LE(1,pos+8); assert.throws(()=>I.preflightZip(b));
});
test('package hash mismatch rejects import and preserves previous valid exam', async t => {
  const {s,root}=await context(t,false); await s.importExam(DEMO); const id=s.exam.id;
  const z=await JSZip.loadAsync(await fsp.readFile(DEMO)); const manifest=JSON.parse(await z.file('manifest.json').async('string'));
  manifest.tasks[0].images[0].sha256='0'.repeat(64); z.file('manifest.json',JSON.stringify(manifest));
  const bad=path.join(root,'bad.oge'); await fsp.writeFile(bad,await z.generateAsync({type:'nodebuffer'}));
  await assert.rejects(s.importExam(bad)); assert.equal(s.exam.id,id);
});
test('editor automatic import assigns task and lexical image ordering; duplicate replaces', async t => {
  const {s}=await context(t,false);
  for (const n of ['2.2.png','2.10.png','2.1.png']) await s.addEditorAsset(IMAGE,n,1,'image',true);
  assert.deepEqual(s.editor.tasks[1].images.map(a=>a.name),['2.1.png','2.10.png','2.2.png']);
  await s.addEditorAsset(IMAGE,'2.1.png',1,'image',true); assert.equal(s.editor.tasks[1].images.length,3);
  assert.deepEqual(await s.addEditorAsset(IMAGE,'random.png',1,'image',true),{ignored:'random.png'});
});
test('editor rejects resource on wrong task and validates publication completeness', async t => {
  const {s}=await context(t,false);
  await assert.rejects(s.addEditorAsset(IMAGE,'source.png',10,'resource'));
  await assert.rejects(s.exportExam(true));
  const draft=await s.exportExam(false); assert.equal(draft.published,false);
  await assert.rejects(s.importExam(s.exportFile(draft.id)));
});
test('published editor roundtrip carries files and requires newly set code', async t => {
  const {s}=await context(t,false); await s.importExam(DEMO,true);
  await s.updateEditor({title:'Новый вариант',code:'NEW-2026'});
  const out=await s.exportExam(true); await s.importExam(s.exportFile(out.id));
  assert.equal(s.exam.title,'Новый вариант'); await s.start(PERSON,'NEW-2026'); assert.equal(s.attempt.status,'active');
});
test('missing/wrong activation never starts timer; invalid registration also blocked', async t => {
  const {s,advance}=await context(t,false); await s.importExam(DEMO);
  await assert.rejects(s.start(PERSON,'')); assert.equal(s.attempt,null); advance(2000);
  await assert.rejects(s.start(PERSON,'WRONG-2026')); assert.equal(s.attempt,null); advance(3000);
  await assert.rejects(s.start({...PERSON,name:''},'DEMO-2026')); assert.equal(s.attempt,null);
  await s.start(PERSON,'DEMO-2026'); assert.equal(s.remaining(),9000000);
});
test('direct task navigation, previous data restoration and editor lock', async t => {
  const {s}=await context(t); await s.navigate(16); assert.equal(s.attempt.currentTask,16);
  await s.navigate(2); assert.equal(s.task(2).kind,'short');
  await assert.rejects(s.navigate(17)); await assert.rejects(s.newEditor()); await assert.rejects(s.importExam(DEMO));
});
test('draft is not a submitted answer; Save records answer durably', async t => {
  const {s}=await context(t); await s.saveDraft(1,'42');
  assert.equal(s.sessionView().savedCount,0); assert.equal(s.sessionView().dirtyCount,1);
  await s.saveAnswer(1,'42'); assert.equal(s.sessionView().savedCount,1); assert.equal(s.sessionView().dirtyCount,0);
  const persisted=await I.readJson(path.join(s.attemptDir(),'session.json')); assert.equal(persisted.answers[1].text,'42');
  await s.saveDraft(1,'43'); assert.equal(s.task(1).savedText,'42'); assert.equal(s.task(1).text,'43');
});
test('uploaded file is copied immediately, explicitly saved, independent of source', async t => {
  const {s,root}=await context(t); const file=path.join(root,'Ответ.py'); await fsp.writeFile(file,'print(42)');
  await s.attachFile(16,file,'Ответ.py'); assert.equal(s.sessionView().savedCount,0);
  await fsp.unlink(file); await s.saveAnswer(16);
  const saved=s.attempt.answers[16].file; assert.equal(await fsp.readFile(path.join(s.attemptDir(),saved.path),'utf8'),'print(42)');
  assert.equal(s.sessionView().savedCount,1);
});
test('wrong answer types are rejected; file cannot be saved before selection', async t => {
  const {s}=await context(t); await assert.rejects(s.saveAnswer(13)); await assert.rejects(s.saveDraft(13,'a'));
  await assert.rejects(s.attachFile(1,IMAGE,'file.png')); await assert.rejects(s.saveAnswer(1,42));
});
test('clearing answer removes submission and draft but preserves other answers', async t => {
  const {s}=await context(t); await s.saveAnswer(1,'1'); await s.saveAnswer(2,'2'); await s.clearAnswer(1);
  assert.equal(s.sessionView().savedCount,1); assert.equal(s.task(1).text,''); assert.equal(s.task(2).savedText,'2');
});
test('manual finish exports all 16 records, full identity, files, drafts and hashes', async t => {
  const {s,root,advance}=await context(t); await s.saveAnswer(1,'160'); await s.saveDraft(2,'черновик');
  const f=path.join(root,'a.py'); await fsp.writeFile(f,'first'); await s.attachFile(16,f,'answer.py'); await s.saveAnswer(16);
  await fsp.writeFile(f,'second'); await s.attachFile(16,f,'new-answer.py'); advance(120000);
  await s.finish('manual'); assert.equal(s.attempt.status,'finished'); assert.equal(s.attempt.finishReason,'manual');
  assert.equal(s.attempt.elapsedMs,120000); assert.ok(s.attempt.archivePath);
  const z=await JSZip.loadAsync(await fsp.readFile(s.attempt.archivePath));
  const data=JSON.parse(await z.file('answers.json').async('string')); assert.equal(data.answers.length,16); assert.equal(data.savedCount,2);
  assert.deepEqual(JSON.parse(await z.file('candidate.json').async('string')),PERSON);
  assert.equal(await z.file('files/task-16/answer.py').async('string'),'first');
  assert.equal(await z.file('draft-files/task-16/new-answer.py').async('string'),'second');
  const drafts=JSON.parse(await z.file('drafts.json').async('string')); assert.equal(drafts.drafts[2].submitted,false);
  const hashes=JSON.parse(await z.file('SHA256.json').async('string'));
  for (const [name,hash] of Object.entries(hashes)) assert.equal(I.crypto.createHash('sha256').update(await z.file(name).async('nodebuffer')).digest('hex'),hash);
  assert.ok(z.file('report.html')); assert.ok(z.file('answers.csv'));
});
test('finish is idempotent and answers remain read-only afterward', async t => {
  const {s}=await context(t); await s.finish(); const archive=s.attempt.archivePath;
  await s.finish(); assert.equal(s.attempt.archivePath,archive);
  await assert.rejects(s.saveAnswer(1,'late')); await assert.rejects(s.saveDraft(1,'late')); await assert.rejects(s.navigate(2));
});
test('automatic timeout is exactly 150 minutes and rejects late saves', async t => {
  const {s,advance}=await context(t); advance(8999999); await s.pulse(); assert.equal(s.attempt.status,'active');
  advance(1); await s.pulse(); assert.equal(s.attempt.status,'finished'); assert.equal(s.attempt.finishReason,'timeout');
  assert.equal(s.attempt.elapsedMs,9000000); assert.ok(s.attempt.archivePath); await assert.rejects(s.saveAnswer(1,'late'));
});
test('deadline is checked on save even before the next periodic timer tick', async t => {
  const {s,advance}=await context(t); advance(9001000); await assert.rejects(s.saveAnswer(1,'late'));
  assert.equal(s.attempt.finishReason,'timeout'); assert.equal(s.attempt.answers[1],undefined);
});
test('restart restores saved and unsaved data without resetting timer', async t => {
  const {s,root,clock,advance}=await context(t); await s.saveAnswer(1,'12'); await s.saveDraft(2,'13'); advance(60000); await s.pulse(true);
  advance(30000); const restored=new ExamService(root,clock); await restored.init();
  assert.equal(restored.remaining(),8910000); assert.equal(restored.task(1).savedText,'12'); assert.equal(restored.task(2).text,'13');
  assert.equal(restored.recovered,true);
});

test('scanned recovery repairs config so finished results survive another restart', async t => {
  const {s,root,clock}=await context(t); await s.saveAnswer(1,'012');
  await fsp.unlink(path.join(root,'config.json')); await fsp.unlink(path.join(root,'config.json.bak'));
  const restored=new ExamService(root,clock); await restored.init();
  assert.equal(restored.attempt.id,s.attempt.id); assert.equal(restored.recovered,true);
  assert.equal((await I.readJson(path.join(root,'config.json'))).attemptId,s.attempt.id);
  await restored.finish();
  const afterFinish=new ExamService(root,clock); await afterFinish.init();
  assert.equal(afterFinish.attempt.id,s.attempt.id); assert.equal(afterFinish.attempt.status,'finished');
  assert.equal(afterFinish.attempt.answers[1].text,'012'); assert.equal(afterFinish.attempt.archivePath,restored.attempt.archivePath);
});
test('restart after deadline automatically completes and exports session', async t => {
  const {s,root,clock,advance}=await context(t); await s.saveAnswer(1,'12'); advance(10000000);
  const restored=new ExamService(root,clock); await restored.init(); assert.equal(restored.attempt.finishReason,'timeout'); assert.ok(restored.attempt.archivePath);
});
test('system clock rollback cannot add time within running process', async t => {
  const {s,time,advance}=await context(t); advance(60000); await s.pulse(true); const before=s.remaining();
  time.wall -= 3600000; time.mono += 10000; await s.pulse(true);
  assert.equal(s.remaining(),before-10000); assert.ok(s.attempt.events.some(e=>e.type==='clock_rollback'));
});
test('failed disk write does not falsely mark an answer as saved', async t => {
  const {s}=await context(t); const file=path.join(s.attemptDir(),'session.json');
  await fsp.rename(file,file+'.held'); await fsp.mkdir(file);
  await assert.rejects(s.saveAnswer(1,'must-not-be-saved')); assert.equal(s.attempt.answers[1],undefined);
  await fsp.rmdir(file); await fsp.rename(file+'.held',file); await s.saveAnswer(1,'now-saved');
  assert.equal(s.attempt.answers[1].text,'now-saved');
});
test('export failure retains finished session; retry produces complete archive', async t => {
  const {s,root}=await context(t); const file=path.join(root,'answer.txt'); await fsp.writeFile(file,'data');
  await s.attachFile(15,file,'answer.txt'); await s.saveAnswer(15); const blob=path.join(s.attemptDir(),s.attempt.answers[15].file.path);
  await fsp.rename(blob,blob+'.held'); await s.finish(); assert.equal(s.attempt.status,'finished'); assert.ok(s.attempt.exportError);
  await fsp.rename(blob+'.held',blob); await s.exportResults(); assert.ok(s.attempt.archivePath); assert.equal(s.attempt.exportError,null);
});
test('report HTML escapes markup and CSV does not allow formula injection', () => {
  assert.equal(html('<script>"&'), '&lt;script&gt;&quot;&amp;');
  assert.equal(csv('=1+1'),'"\'=1+1"'); assert.equal(csv('12'),'"12"');
});
test('unwritable result target reports export failure without losing finished state', async t => {
  const {s}=await context(t); const target=s.dir('results');await fsp.rmdir(target);await fsp.writeFile(target,'blocked');
  await s.finish();assert.equal(s.attempt.status,'finished');assert.ok(s.attempt.exportError);
  await fsp.unlink(target);await fsp.mkdir(target);await s.exportResults();assert.ok(s.attempt.archivePath);
});
test('duplicate ZIP entries are rejected without writing files', async () => {
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const data=await zipData([['manifest.json','{}'],[`assets/${a}.bin`,'a'],[`assets/${b}.bin`,'b']]);
  const needle=Buffer.from(b),replacement=Buffer.from(a);let index=0;
  while((index=data.indexOf(needle,index))>=0){replacement.copy(data,index);index+=needle.length;}
  assert.throws(()=>I.preflightZip(data));
});
