'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {fsp,path,JSZip}=require('../src/io.cjs');
const {startServer,openBrowser}=require('../src/server.cjs');
const PERSON={registration:'00012345',surname:'Тестовый',name:'Ученик',passportSeries:'0000',passportNumber:'000000'};
const TEACHER_PASSWORD='HTTP teacher test password';
async function server(t,options={}) {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-http-'));
  const app=await startServer({root,open:false,lock:false,...options});
  t.after(async()=>{await app.close();await fsp.rm(root,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${app.key}`};
  return {app,root,headers,async post(route,body={},extraHeaders={}) {
    const res=await fetch(app.url+route,{method:'POST',headers:{...headers,...extraHeaders,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:res.status,body:await res.json(),retryAfter:res.headers.get('retry-after')};
  }};
}
async function teacher(post) {
  const setup=await post('/api/teacher/setup',{password:TEACHER_PASSWORD});
  assert.equal(setup.status,200);assert.match(setup.body.value.token,/^[a-f0-9]{64}$/);
  return {'X-Teacher-Token':setup.body.value.token};
}
async function state(app,headers) {
  const res=await fetch(app.url+'/api/state',{headers});assert.equal(res.status,200);
  return (await res.json()).value;
}
function noTeacherRefs(value) {
  for(const exam of [value.editor,value.exam]) if(exam) {
    assert.equal(Object.hasOwn(exam,'activation'),false);
    assert.equal(exam.tasks.some(task=>Object.hasOwn(task,'checker')),false);
  }
  assert.equal(JSON.stringify(value).includes(TEACHER_PASSWORD),false);
}
test('loopback bind, CSP and static UI; private helper may open main page',async t=>{
  const {app}=await server(t);assert.equal(app.server.address().address,'127.0.0.1');
  const res=await fetch(app.url,{headers:{'Sec-Fetch-Site':'cross-site'}});
  assert.equal(res.status,200);assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'),'DENY');assert.match(await res.text(),/Симулятор/);
});
test('browser launchers receive only an encoded private file URL on every platform',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-browser-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'Закрытый helper #%.html'),url=pathToFileURL(file).href;
  const cases=[
    {platform:'linux',available:'chromium',command:'/usr/bin/chromium',args:[`--app=${url}`]},
    {platform:'linux',available:'xdg-open',command:'/usr/bin/xdg-open',args:[url]},
    {platform:'darwin',command:'/usr/bin/open',args:[url]},
    {platform:'win32',command:'rundll32.exe',args:['url.dll,FileProtocolHandler',url]}
  ];
  for(const example of cases) await t.test(example.platform+' '+(example.available||example.command),async()=>{
    const launches=[];
    await openBrowser(file,{platform:example.platform,
      findExecutable:async name=>name===example.available?'/usr/bin/'+name:null,
      launchProcess:async(command,args)=>{launches.push({command,args});}});
    assert.deepEqual(launches,[{command:example.command,args:example.args}]);
    assert.equal(new URL(url).protocol,'file:');assert.equal(new URL(url).hash,'');
    assert.equal(fileURLToPath(url),file);
  });
  await assert.rejects(openBrowser(file,{platform:'linux',findExecutable:async()=>null,
    launchProcess:async()=>assert.fail('Missing browsers must not launch a process')}),/OPEN-IN-BROWSER\.html/);
});
test('automatic app-window launch keeps its token inside owner-only HTML, not process arguments or public UI',async t=>{
  const launches=[];
  const {app,root}=await server(t,{open:true,lock:true,browserLauncher:file=>openBrowser(file,{platform:'linux',
    findExecutable:async name=>name==='chromium'?'/usr/bin/chromium':null,
    launchProcess:async(command,args)=>{launches.push({command,args});}})});
  assert.equal(launches.length,1);assert.equal(launches[0].command,'/usr/bin/chromium');
  const argument=launches[0].args[0];assert.ok(argument.startsWith('--app=file:'));
  assert.equal(argument.includes(app.key),false);assert.equal(argument.includes(app.url),false);
  const file=fileURLToPath(argument.slice('--app='.length));
  assert.equal(path.dirname(file),root);assert.notEqual(path.basename(file),'OPEN-IN-BROWSER.html');
  const page=await fsp.readFile(file,'utf8'),target=`${app.url}/#${app.key}`;
  assert.ok(page.includes(`<meta http-equiv="refresh" content="0;url=${target}">`));
  assert.ok(page.includes(`<a href="${target}">`));assert.match(page,/name="referrer" content="no-referrer"/);
  assert.equal(await fsp.readFile(path.join(root,'OPEN-IN-BROWSER.html'),'utf8'),page);
  if(process.platform!=='win32') for(const helper of [file,path.join(root,'OPEN-IN-BROWSER.html')])
    assert.equal((await fsp.stat(helper)).mode&0o777,0o600);
  const publicPage=await (await fetch(app.url)).text();assert.equal(publicPage.includes(app.key),false);
  assert.equal((await fetch(app.url+'/OPEN-IN-BROWSER.html')).status,401);
});
test('replacing the manual helper cannot retarget a pending automatic browser open or its cleanup',async t=>{
  let openedFile,openedPage;
  const replacement='Another instance now owns the manual helper';
  const {app,root}=await server(t,{open:true,browserLauncher:async file=>{
    openedFile=file;
    await fsp.writeFile(path.join(path.dirname(file),'OPEN-IN-BROWSER.html'),replacement);
    openedPage=await fsp.readFile(file,'utf8');
  }});
  assert.ok(openedPage.includes(`${app.url}/#${app.key}`));
  await app.close();
  await assert.rejects(fsp.stat(openedFile),{code:'ENOENT'});
  assert.equal(await fsp.readFile(path.join(root,'OPEN-IN-BROWSER.html'),'utf8'),replacement);
});
test('authenticated existing-instance launch regenerates legacy bootstrap and respects no-open',async t=>{
  const {app,root}=await server(t,{lock:true});
  const record=path.join(root,'instance.lock','connection.json'),info=JSON.parse(await fsp.readFile(record,'utf8'));
  delete info.browserId;
  const legacy=JSON.stringify(info);await fsp.writeFile(record,legacy);
  await fsp.writeFile(path.join(root,'OPEN-IN-BROWSER.html'),'Stale launcher');
  const launches=[];
  const two=await startServer({root,open:true,browserLauncher:file=>openBrowser(file,{platform:'win32',
    launchProcess:async(command,args)=>{launches.push({command,args});}})});
  assert.equal(two.existing,true);assert.equal(two.url,app.url);assert.equal(two.key,app.key);
  assert.equal(launches.length,1);assert.equal(launches[0].args.join(' ').includes(app.key),false);
  const file=fileURLToPath(launches[0].args.at(-1)),page=await fsp.readFile(file,'utf8');
  assert.ok(page.includes(`content="0;url=${app.url}/#${app.key}"`));
  assert.equal(await fsp.readFile(path.join(root,'OPEN-IN-BROWSER.html'),'utf8'),page);
  assert.equal(await fsp.readFile(record,'utf8'),legacy);
  const three=await startServer({root,open:false,browserLauncher:async()=>assert.fail('no-open must not launch')});
  assert.equal(three.existing,true);assert.equal(launches.length,1);
});
test('no-open still creates the manual bootstrap without invoking a browser',async t=>{
  const {app,root}=await server(t,{browserLauncher:async()=>assert.fail('no-open must not launch')});
  const page=await fsp.readFile(path.join(root,'OPEN-IN-BROWSER.html'),'utf8');
  assert.ok(page.includes(`content="0;url=${app.url}/#${app.key}"`));
});
test('API rejects missing/incorrect token, cross-site origin and host rebinding',async t=>{
  const {app,headers}=await server(t);
  assert.equal((await fetch(app.url+'/api/state')).status,401);
  assert.equal((await fetch(app.url+'/api/state',{headers:{Authorization:'Bearer invalid'}})).status,401);
  assert.equal((await fetch(app.url+'/api/state',{headers:{...headers,Origin:'https://evil.example'}})).status,400);
  assert.equal((await fetch(app.url+'/api/state',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,400);
  const hostStatus=await new Promise((resolve,reject)=>{ require('node:http').get(app.url+'/api/state',{headers:{...headers,Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject); });
  assert.equal(hostStatus,400);
  const good=await fetch(app.url+'/api/state',{headers});assert.equal(good.status,200);
});
test('API does not expose filesystem paths or unpublished internal data',async t=>{
  const {app,headers}=await server(t);
  assert.equal((await fetch(app.url+'/api/asset?id=../../etc/passwd',{headers})).status,403);
  assert.equal((await fetch(app.url+'/src/service.cjs',{headers})).status,404);
  assert.equal((await fetch(app.url+'/api/result',{headers})).status,400);
});

test('teacher capabilities are per request, require the main bearer and cannot reset an existing password',async t=>{
  let offset=0;
  const {app,headers,post}=await server(t,{clock:{now:()=>Date.now()+offset,monotonic:()=>offset}});
  assert.deepEqual((await state(app,headers)).teacher,{configured:false,unlocked:false});
  const unauth=await fetch(app.url+'/api/teacher/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:TEACHER_PASSWORD})});
  assert.equal(unauth.status,401);assert.equal(app.service.teacherConfigured(),false);
  const crossSite=await post('/api/teacher/setup',{password:TEACHER_PASSWORD},{Origin:'https://evil.example'});
  assert.equal(crossSite.status,400);assert.equal(app.service.teacherConfigured(),false);
  assert.equal((await post('/api/editor/new')).status,403);
  assert.equal((await post('/api/teacher/setup',{password:'short'})).status,400);
  const capability=await teacher(post),authorized={...headers,...capability};
  assert.equal((await state(app,authorized)).teacher.unlocked,true);
  assert.ok((await state(app,authorized)).editor);
  assert.equal((await post('/api/editor/checker',{taskId:1,checker:{type:'short',answers:['HIDDEN-TEACHER-ANSWER']}},capability)).status,200);
  for(const visitor of [headers,{...headers,'X-Teacher-Token':'a'.repeat(64)}]) {
    const view=await state(app,visitor);noTeacherRefs(view);
    assert.equal(JSON.stringify(view).includes('HIDDEN-TEACHER-ANSWER'),false);
    assert.deepEqual(view.teacher,{configured:true,unlocked:false});
  }
  const routes=['/api/editor/new','/api/editor/update','/api/editor/checker','/api/editor/remove','/api/editor/export','/api/review/check','/api/teacher/lock'];
  for(const route of routes) assert.equal((await post(route)).status,403,route);
  assert.equal((await post('/api/demo',{edit:true})).status,403);
  assert.equal((await post('/api/editor/update',{title:'Denied',token:capability['X-Teacher-Token']})).status,403);
  const onlyTeacher=await fetch(app.url+'/api/editor/new',{method:'POST',headers:{...capability,'Content-Type':'application/json'},body:'{}'});
  assert.equal(onlyTeacher.status,401);
  for(const route of ['/api/package?id=00000000-0000-0000-0000-000000000000','/api/review/report?id=00000000-0000-0000-0000-000000000000','/api/asset?id=00000000-0000-0000-0000-000000000000'])
    assert.equal((await fetch(app.url+route,{headers})).status,403,route);
  for(const route of ['kind=image&task=1&name=test.png','kind=image&auto=1&name=1.png','kind=resource&task=11&name=task.txt','kind=review&name=results.zip','kind=package&edit=1&name=project.oge'])
    assert.equal((await fetch(app.url+'/api/upload?'+route,{method:'POST',headers,body:'denied'})).status,403,route);
  assert.equal((await post('/api/teacher/setup',{password:'A replacement password'},capability)).status,409);
  assert.equal((await post('/api/teacher/lock',{},capability)).status,200);
  noTeacherRefs(await state(app,authorized));
  const bad=await post('/api/teacher/unlock',{password:'A replacement password'});
  assert.equal(bad.status,403);assert.deepEqual(bad.body,{ok:false,error:'Не удалось войти как преподаватель.'});
  const throttled=await post('/api/teacher/unlock',{password:TEACHER_PASSWORD});
  assert.equal(throttled.status,429);assert.ok(Number(throttled.retryAfter)>=1);
  assert.equal(Object.hasOwn(throttled.body,'value'),false);
  offset+=60000;
  const unlocked=await post('/api/teacher/unlock',{password:TEACHER_PASSWORD});
  assert.equal(unlocked.status,200);assert.notEqual(unlocked.body.value.token,capability['X-Teacher-Token']);
  const current={'X-Teacher-Token':unlocked.body.value.token};
  assert.equal((await post('/api/editor/update',{title:'Allowed'},current)).status,200);
  assert.equal((await post('/api/editor/update',{title:'Old token'},capability)).status,403);
  offset+=15*60*1000+1;
  assert.equal((await post('/api/editor/update',{title:'Expired'},current)).status,403);
  noTeacherRefs(await state(app,{...headers,...current}));
  assert.equal((await post('/api/teacher/setup',{password:'Another replacement password'})).status,409);
});

test('teacher can edit, upload assets, export private projects and download packages with both capabilities',async t=>{
  const {app,headers,post}=await server(t),capability=await teacher(post),authorized={...headers,...capability};
  assert.equal((await post('/api/editor/new',{},capability)).status,200);
  assert.equal((await post('/api/demo',{edit:true},capability)).status,200);
  assert.equal((await post('/api/editor/update',{title:'Private teacher project'},capability)).status,200);
  const checker={type:'short',answers:['PRIVATE-REFERENCE']};
  assert.equal((await post('/api/editor/checker',{taskId:1,checker},capability)).status,200);
  const view=await state(app,authorized),image=view.editor.tasks[0].images[0];
  assert.equal(view.editor.tasks[0].checker.answers[0],'PRIVATE-REFERENCE');
  assert.equal(JSON.stringify(await state(app,headers)).includes('PRIVATE-REFERENCE'),false);
  assert.equal((await fetch(app.url+'/api/asset?id='+image.id,{headers})).status,403);
  assert.equal((await fetch(app.url+'/api/asset?id='+image.id,{headers:authorized})).status,200);
  const source=await (await fetch(app.url+'/api/asset?id='+image.id,{headers:authorized})).arrayBuffer();
  const imageUpload=await fetch(app.url+'/api/upload?kind=image&task=1&name=teacher.png',{method:'POST',headers:authorized,body:source});
  assert.equal(imageUpload.status,200);await imageUpload.json();
  const resource=await fetch(app.url+'/api/upload?kind=resource&task=11&name=teacher.txt',{method:'POST',headers:authorized,body:'Teacher resource'});
  assert.equal(resource.status,200);const uploaded=(await resource.json()).value.editor.tasks[10].resources.find(a=>a.name==='teacher.txt');
  assert.ok(uploaded);assert.equal((await post('/api/editor/remove',{id:uploaded.id},capability)).status,200);
  assert.equal((await fetch(app.url+'/api/asset?id='+uploaded.id,{headers:authorized})).status,404);
  const project=await post('/api/editor/export',{publish:false},capability);assert.equal(project.status,200);
  const route='/api/package?id='+project.body.value.id;
  assert.equal((await fetch(app.url+route,{headers})).status,403);
  const download=await fetch(app.url+route,{headers:authorized});assert.equal(download.status,200);
  const bytes=Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.includes(Buffer.from('PRIVATE-REFERENCE')),false);
  await assert.rejects(JSZip.loadAsync(bytes));
  assert.deepEqual(bytes,await fsp.readFile(app.service.exportFile(project.body.value.id)));
  const rejected=await fetch(app.url+'/api/upload?kind=package&name=project.oge',{method:'POST',headers,body:bytes});
  assert.equal(rejected.status,400);await rejected.json();
  const edit=await fetch(app.url+'/api/upload?kind=package&edit=1&name=project.oge',{method:'POST',headers:authorized,body:bytes});
  assert.equal(edit.status,200);assert.equal((await edit.json()).value.tasks[0].checker.answers[0],'PRIVATE-REFERENCE');
});

test('protected teacher projects transfer with encoded Unicode passwords and reject malformed or student imports',async t=>{
  const source=await server(t),password='Пароль проекта 123 % 😀';
  const setup=await source.post('/api/teacher/setup',{password});assert.equal(setup.status,200);
  const sourceCapability={'X-Teacher-Token':setup.body.value.token},sourceHeaders={...source.headers,...sourceCapability};
  await source.post('/api/demo',{edit:true},sourceCapability);
  await source.post('/api/editor/checker',{taskId:1,checker:{type:'short',answers:['FOREIGN-PRIVATE-REFERENCE']}},sourceCapability);
  const exported=await source.post('/api/editor/export',{publish:false},sourceCapability);assert.equal(exported.status,200);
  const downloaded=await fetch(source.app.url+'/api/package?id='+exported.body.value.id,{headers:sourceHeaders});assert.equal(downloaded.status,200);
  const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(bytes.includes(Buffer.from('FOREIGN-PRIVATE-REFERENCE')),false);
  const target=await server(t),targetCapability=await teacher(target.post),targetHeaders={...target.headers,...targetCapability};
  const route='/api/upload?kind=package&edit=1&name=project.oge';
  async function upload(headers=targetHeaders,suffix='') {
    const res=await fetch(target.app.url+route+suffix,{method:'POST',headers,body:bytes});
    return {status:res.status,body:await res.json()};
  }
  const missing=await upload();assert.equal(missing.status,400);assert.equal(missing.body.code,'PROJECT_PASSWORD_REQUIRED');
  const wrong=await upload({...targetHeaders,'X-Project-Password':encodeURIComponent('Incorrect project password')});
  assert.equal(wrong.status,400);assert.equal(wrong.body.code,'PROJECT_PASSWORD_INVALID');
  assert.equal(JSON.stringify(wrong.body).includes(password),false);
  for(const invalid of ['', '%', '%00', 'x'.repeat(1537),encodeURIComponent('x'.repeat(129))]) {
    const res=await upload({...targetHeaders,'X-Project-Password':invalid});assert.equal(res.status,400);
    assert.equal(Object.hasOwn(res.body,'code'),false);
  }
  const student=await upload({...target.headers,'X-Project-Password':encodeURIComponent(password)});assert.equal(student.status,403);
  const publishedRoute=await fetch(target.app.url+'/api/upload?kind=package&name=project.oge',{method:'POST',headers:{...target.headers,'X-Project-Password':encodeURIComponent(password)},body:bytes});
  assert.equal(publishedRoute.status,400);await publishedRoute.json();
  const good=await upload({...targetHeaders,'X-Project-Password':encodeURIComponent(password)});
  assert.equal(good.status,200);assert.equal(good.body.value.tasks[0].checker.answers[0],'FOREIGN-PRIVATE-REFERENCE');
  noTeacherRefs(await state(target.app,target.headers));
  assert.equal(JSON.stringify(await state(target.app,target.headers)).includes('FOREIGN-PRIVATE-REFERENCE'),false);
});

test('shared-PC pupil flow locks the teacher, hides private assets and retains activation, answers, results and teacher review',async t=>{
  let offset=0;
  const {app,headers,post}=await server(t,{clock:{now:()=>Date.now()+offset,monotonic:()=>offset}});
  const capability=await teacher(post),authorized={...headers,...capability};
  await post('/api/demo',{edit:true},capability);
  await post('/api/editor/checker',{taskId:1,checker:{type:'short',answers:['42']}},capability);
  const published=await post('/api/editor/export',{publish:true},capability);assert.equal(published.status,200);
  const packageResponse=await fetch(app.url+'/api/package?id='+published.body.value.id,{headers:authorized});
  assert.equal(packageResponse.status,200);const bytes=Buffer.from(await packageResponse.arrayBuffer());
  const hidden=await fetch(app.url+'/api/upload?kind=resource&task=11&name=teacher-only.txt',{method:'POST',headers:authorized,body:'Private preparation file'});
  assert.equal(hidden.status,200);const privateId=(await hidden.json()).value.editor.tasks[10].resources.find(a=>a.name==='teacher-only.txt').id;
  const imported=await fetch(app.url+'/api/upload?kind=package&name=exam.oge',{method:'POST',headers,body:bytes});
  assert.equal(imported.status,200);await imported.json();
  assert.equal(app.service.teacherAuthorized(capability['X-Teacher-Token']),false);
  noTeacherRefs(await state(app,authorized));
  assert.equal((await post('/api/editor/update',{title:'Pupil edit'},capability)).status,403);
  const beforeStart=await post('/api/teacher/unlock',{password:TEACHER_PASSWORD});assert.equal(beforeStart.status,200);
  assert.equal(app.service.teacherAuthorized(beforeStart.body.value.token),true);
  assert.equal((await post('/api/start',{candidate:PERSON,code:'wrong'})).status,403);offset+=4000;
  assert.equal((await post('/api/start',{candidate:PERSON,code:'DEMO-2026'})).status,200);
  assert.equal(app.service.teacherAuthorized(beforeStart.body.value.token),false);
  const active=await state(app,headers);assert.equal(active.session.status,'active');assert.equal(active.editor,null);
  assert.equal(JSON.stringify(active).includes('checker'),false);
  assert.equal((await post('/api/teacher/unlock',{password:TEACHER_PASSWORD})).status,400);
  const task=await post('/api/navigate',{id:11});assert.equal(task.status,200);
  assert.equal((await fetch(app.url+'/api/asset?id='+task.body.value.resources[0].id,{headers})).status,200);
  assert.equal((await fetch(app.url+'/api/asset?id='+privateId,{headers})).status,404);
  assert.equal((await post('/api/save',{id:1,text:'42'})).status,200);
  assert.equal((await post('/api/draft',{id:2,text:'draft'})).status,200);
  assert.equal((await post('/api/clear',{id:2})).status,200);
  const answer=await fetch(app.url+'/api/upload?kind=answer&task=16&name=answer.py',{method:'POST',headers,body:'print(42)'});
  assert.equal(answer.status,200);await answer.json();
  assert.equal((await post('/api/save',{id:16})).status,200);
  assert.equal((await post('/api/finish',{confirm:true})).status,200);
  const result=await fetch(app.url+'/api/result',{headers});assert.equal(result.status,200);
  const resultBytes=Buffer.from(await result.arrayBuffer()),resultZip=await JSZip.loadAsync(resultBytes);
  assert.equal(await resultZip.file('files/task-16/answer.py').async('string'),'print(42)');
  assert.equal((await fetch(app.url+'/api/asset?id='+task.body.value.resources[0].id,{headers})).status,403);
  const dismissed=await post('/api/dismiss');assert.equal(dismissed.status,200);noTeacherRefs(dismissed.body.value);
  const unlocked=await post('/api/teacher/unlock',{password:TEACHER_PASSWORD});assert.equal(unlocked.status,200);
  const reviewCapability={'X-Teacher-Token':unlocked.body.value.token},reviewHeaders={...headers,...reviewCapability};
  const reviewUpload=await fetch(app.url+'/api/upload?kind=review&name=results.zip',{method:'POST',headers:reviewHeaders,body:resultBytes});
  assert.equal(reviewUpload.status,200);const review=(await reviewUpload.json()).value;
  const checked=await post('/api/review/check',{id:review.id,allowUnmatched:true},reviewCapability);
  assert.equal(checked.status,200);assert.equal(checked.body.value.tasks[0].status,'correct');
  assert.equal((await fetch(app.url+'/api/review/report?id='+review.id,{headers})).status,403);
  const makeReport=app.service.reviewReport.bind(app.service);let reportFile,cleaned=false;
  app.service.reviewReport=async id=>{
    const report=await makeReport(id);reportFile=report.file;
    return {...report,cleanup:async()=>{await report.cleanup();cleaned=true;}};
  };
  const reportResponse=await fetch(app.url+'/api/review/report?id='+review.id,{headers:reviewHeaders});assert.equal(reportResponse.status,200);
  const reportZip=await JSZip.loadAsync(Buffer.from(await reportResponse.arrayBuffer()));assert.ok(reportZip.file('assessment.json'));
  const cleanupDeadline=Date.now()+3000;
  while(!cleaned&&Date.now()<cleanupDeadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(cleaned,true);await assert.rejects(fsp.stat(reportFile),{code:'ENOENT'});
  await app.close();
  const restarted=await startServer({root:app.root,open:false,lock:false});
  try {
    const visitor={Authorization:`Bearer ${restarted.key}`,'X-Teacher-Token':reviewCapability['X-Teacher-Token']};
    const afterRestart=await state(restarted,visitor);noTeacherRefs(afterRestart);
    assert.deepEqual(afterRestart.teacher,{configured:true,unlocked:false});
    assert.equal((await fetch(restarted.url+'/api/review/report?id='+review.id,{headers:visitor})).status,403);
    assert.equal((await fetch(restarted.url+'/api/package?id='+published.body.value.id,{headers:visitor})).status,403);
    const setupAgain=await fetch(restarted.url+'/api/teacher/setup',{method:'POST',headers:{...visitor,'Content-Type':'application/json'},body:JSON.stringify({password:'A replacement password'})});
    assert.equal(setupAgain.status,409);
    const unlock=await fetch(restarted.url+'/api/teacher/unlock',{method:'POST',headers:{...visitor,'Content-Type':'application/json'},body:JSON.stringify({password:TEACHER_PASSWORD})});
    assert.equal(unlock.status,200);const token=(await unlock.json()).value.token;
    const teacherView=await state(restarted,{Authorization:`Bearer ${restarted.key}`,'X-Teacher-Token':token});
    assert.deepEqual(teacherView.editor.tasks[0].checker.answers,['42']);
  } finally {await restarted.close();}
});

test('a pupil with only a published file needs no teacher setup to complete the exam',async t=>{
  const {app,headers,post}=await server(t),bytes=await fsp.readFile(path.join(__dirname,'../examples/demo.oge'));
  const imported=await fetch(app.url+'/api/upload?kind=package&name=exam.oge',{method:'POST',headers,body:bytes});
  assert.equal(imported.status,200);await imported.json();
  assert.deepEqual((await state(app,headers)).teacher,{configured:false,unlocked:false});
  noTeacherRefs(await state(app,headers));
  assert.equal((await post('/api/demo',{edit:true})).status,403);
  assert.equal((await post('/api/start',{candidate:PERSON,code:'DEMO-2026'})).status,200);
  assert.equal((await post('/api/save',{id:1,text:'42'})).status,200);
  assert.equal((await post('/api/finish',{confirm:true})).status,200);
  assert.equal((await fetch(app.url+'/api/result',{headers})).status,200);
});

test('teacher upload authorization is checked again after streaming and expired uploads leave no editor changes',async t=>{
  let offset=0;
  const {app,root,headers,post}=await server(t,{clock:{now:()=>Date.now()+offset,monotonic:()=>offset}});
  const capability=await teacher(post);await post('/api/demo',{edit:true},capability);
  let request;
  const response=new Promise((resolve,reject)=>{
    request=require('node:http').request(app.url+'/api/upload?kind=resource&task=11&name=expired.txt',{method:'POST',headers:{...headers,...capability}},res=>{
      let data='';res.setEncoding('utf8');res.on('data',chunk=>{data+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
    });request.on('error',reject);request.write('First upload chunk\n');
  });
  t.after(()=>request.destroy());
  const deadline=Date.now()+3000;
  while(!(await fsp.readdir(path.join(root,'incoming'))).length&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await fsp.readdir(path.join(root,'incoming'))).length,1);
  offset+=15*60*1000+1;request.end('Last upload chunk\n');
  assert.equal((await response).status,403);
  const cleanupDeadline=Date.now()+3000;
  while((await fsp.readdir(path.join(root,'incoming'))).length&&Date.now()<cleanupDeadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(await fsp.readdir(path.join(root,'incoming')),[]);
  const unlocked=await post('/api/teacher/unlock',{password:TEACHER_PASSWORD});assert.equal(unlocked.status,200);
  const view=await state(app,{...headers,'X-Teacher-Token':unlocked.body.value.token});
  assert.equal(view.editor.tasks[10].resources.some(a=>a.name==='expired.txt'),false);
});

test('theme changes require authorization and accept only fixed appearance names',async t=>{
  const {app,post,headers}=await server(t);
  assert.equal(app.service.state().theme,'light');
  assert.match(await (await fetch(app.url)).text(),/<html lang="ru" data-theme="light">/);
  assert.equal((await fetch(app.url+'/api/theme',{method:'POST',body:'{"theme":"dark"}'})).status,401);
  assert.equal((await fetch(app.url+'/api/theme',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{"theme":"dark"}'})).status,400);
  for(const theme of ['auto','<script>',null,1,{}]) assert.equal((await post('/api/theme',{theme})).status,400);
  assert.equal(app.service.state().theme,'light');
  const dark=await post('/api/theme',{theme:'dark'});
  assert.equal(dark.status,200);assert.equal(dark.body.value,'dark');
  assert.match(await (await fetch(app.url)).text(),/<html lang="ru" data-theme="dark">/);
  await post('/api/theme',{theme:'light'});
  assert.match(await (await fetch(app.url)).text(),/<html lang="ru" data-theme="light">/);
});

test('night theme survives restart on a different port alongside exam and drafts',async t=>{
  const {app,root,post}=await server(t);
  await post('/api/demo');await post('/api/start',{candidate:PERSON,code:'DEMO-2026'});
  await post('/api/save',{id:1,text:'42'});
  await post('/api/draft',{id:2,text:'unsaved'});
  const examId=app.service.config.examId,attemptId=app.service.attempt.id;
  await post('/api/theme',{theme:'dark'});
  assert.equal(app.service.config.examId,examId);assert.equal(app.service.config.attemptId,attemptId);
  const previousPort=app.server.address().port;
  await app.close();
  // Reserve the old port to ensure this checks a new browser storage origin.
  const reserve=require('node:http').createServer();
  await new Promise(resolve=>reserve.listen(previousPort,'127.0.0.1',resolve));
  let restarted;
  try {
    restarted=await startServer({root,open:false,lock:false});
    assert.notEqual(restarted.server.address().port,previousPort);
    assert.equal(restarted.service.state().theme,'dark');
    assert.match(await (await fetch(restarted.url)).text(),/<html lang="ru" data-theme="dark">/);
    assert.equal(restarted.service.config.examId,examId);
    assert.equal(restarted.service.attempt.id,attemptId);
    assert.equal(restarted.service.attempt.status,'active');
    assert.equal(restarted.service.task(1).text,'42');
    assert.equal(restarted.service.task(2).text,'unsaved');
    const res=await fetch(restarted.url+'/api/theme',{method:'POST',headers:{Authorization:`Bearer ${restarted.key}`,'Content-Type':'application/json'},body:'{"theme":"light"}'});
    assert.equal(res.status,200);
    assert.equal((await fsp.readFile(path.join(root,'config.json'),'utf8')).includes('"theme": "light"'),true);
  } finally {await restarted?.close();await new Promise(resolve=>reserve.close(resolve));}
});
test('full HTTP flow: activate, save, download supplied file, upload, confirm, ZIP',async t=>{
  const {app,headers,post}=await server(t);
  assert.equal((await post('/api/demo')).status,200);
  assert.equal((await post('/api/start',{candidate:PERSON,code:'DEMO-2026'})).status,200);
  const task=await post('/api/navigate',{id:11});assert.equal(task.body.value.kind,'short');
  const download=await fetch(app.url+'/api/asset?id='+task.body.value.resources[0].id,{headers});
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.ok((await download.arrayBuffer()).byteLength);
  await post('/api/save',{id:11,text:'3'});
  const upload=await fetch(app.url+'/api/upload?kind=answer&task=16&name=answer.py',{method:'POST',headers,body:'print(42)'});
  assert.equal(upload.status,200);await upload.json();
  assert.equal((await post('/api/save',{id:16})).status,200);
  assert.equal((await post('/api/finish',{confirm:false})).status,400);assert.equal(app.service.attempt.status,'active');
  const end=await post('/api/finish',{confirm:true});assert.equal(end.body.value.savedCount,2);assert.equal(end.body.value.archiveReady,true);
  const res=await fetch(app.url+'/api/result',{headers});const zip=await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  assert.equal(await zip.file('files/task-16/answer.py').async('string'),'print(42)');
  assert.equal((await post('/api/save',{id:1,text:'late'})).status,400);
});

test('explicit result directory is used by HTTP export and download after restart', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-http-visible-'));
  const resultsRoot = path.join(root, 'Документы', 'Результаты');
  let app = await startServer({ root, resultsRoot, open:false, lock:false });
  t.after(async () => { await app.close(); await fsp.rm(root, { recursive:true, force:true }); });
  await app.service.importExam(path.join(__dirname, '../examples/demo.oge'));
  await app.service.start(PERSON, 'DEMO-2026'); await app.service.saveAnswer(1, '42'); await app.service.finish();
  const archive = await fsp.readFile(app.service.attempt.archivePath);
  assert.equal(path.dirname(app.service.attempt.archivePath), resultsRoot);
  await app.close(); app = await startServer({ root, resultsRoot, open:false, lock:false });
  const headers = { Authorization:`Bearer ${app.key}` };
  const state = await (await fetch(app.url + '/api/state', { headers })).json();
  assert.equal(state.value.resultsRoot, resultsRoot); assert.equal(state.value.session.archiveReady, true);
  const response = await fetch(app.url + '/api/result', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
  assert.equal((await fsp.readdir(resultsRoot)).length, 2);
});
test('upload rejects path traversal in filenames',async t=>{
  const {app,headers}=await server(t);
  const res=await fetch(app.url+'/api/upload?kind=image&task=1&name=..%2Fevil.png',{method:'POST',headers,body:'x'});assert.equal(res.status,400);
});
test('single instance opens the same running service without acquiring second timer',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-lock-'));
  const one=await startServer({root,open:false});
  try {
    const two=await startServer({root,open:false});assert.equal(two.existing,true);assert.equal(two.url,one.url);
  } finally {await one.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('stale instance lock with a reused live PID starts a new service',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-stale-lock-'));
  let app;
  t.after(async()=>{await app?.close();await fsp.rm(root,{recursive:true,force:true});});
  // Allocate an unused loopback address, then close it to model a dead server.
  const dead=require('node:http').createServer();
  await new Promise(resolve=>dead.listen(0,'127.0.0.1',resolve));
  const deadUrl=`http://127.0.0.1:${dead.address().port}`;
  await new Promise(resolve=>dead.close(resolve));
  await fsp.mkdir(path.join(root,'instance.lock'));
  await fsp.writeFile(path.join(root,'instance.lock/connection.json'),JSON.stringify({pid:process.pid,url:deadUrl,key:'a'.repeat(64)}));
  app=await startServer({root,open:false});
  assert.notEqual(app.existing,true); assert.equal(app.service.root,root);
  const health=await fetch(app.url+'/api/health',{headers:{Authorization:`Bearer ${app.key}`}});
  assert.equal(health.status,200); assert.deepEqual(await health.json(),{ok:true,pid:process.pid});
});

test('uncertain instance health preserves the lock instead of starting another timer',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-uncertain-lock-'));
  const uncertain=require('node:http').createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('null');});
  await new Promise(resolve=>uncertain.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>uncertain.close(resolve));await fsp.rm(root,{recursive:true,force:true});});
  await fsp.mkdir(path.join(root,'instance.lock'));
  const file=path.join(root,'instance.lock/connection.json');
  const original=JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${uncertain.address().port}`,key:'a'.repeat(64)});
  await fsp.writeFile(file,original);
  const helper=path.join(root,'OPEN-IN-BROWSER.html');await fsp.writeFile(helper,'Preserve until authenticated');
  await assert.rejects(startServer({root,open:true,browserLauncher:async()=>assert.fail('Unauthenticated instance must not launch')}),/Не удалось проверить запущенное приложение/);
  assert.equal(await fsp.readFile(file,'utf8'),original);
  assert.equal(await fsp.readFile(helper,'utf8'),'Preserve until authenticated');
  assert.deepEqual((await fsp.readdir(root)).sort(),['OPEN-IN-BROWSER.html','instance.lock']);
});
test('server finishes on its own without browser polling',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-no-browser-'));let offset=0;
  const app=await startServer({root,open:false,lock:false,clock:{now:()=>Date.now()+offset,monotonic:()=>performance.now()+offset}});
  t.after(async()=>{await app.close();await fsp.rm(root,{recursive:true,force:true});});
  await app.serial(async()=>{await app.service.importExam(path.join(__dirname,'../examples/demo.oge'));await app.service.start(PERSON,'DEMO-2026');});
  offset=9001000;
  // No GET /api/state and no browser: the server's own 500 ms interval must finish.
  const end=Date.now()+5000;
  while(!app.service.attempt.archivePath&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
  assert.equal(app.service.attempt.status,'finished');assert.equal(app.service.attempt.finishReason,'timeout');assert.ok(app.service.attempt.archivePath);
});
