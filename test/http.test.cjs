'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {fsp,path,JSZip}=require('../src/io.cjs');
const {startServer}=require('../src/server.cjs');
const PERSON={registration:'00012345',surname:'Тестовый',name:'Ученик',passportSeries:'0000',passportNumber:'000000'};
async function server(t) {
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'oge-http-'));
  const app=await startServer({root,open:false,lock:false});
  t.after(async()=>{await app.close();await fsp.rm(root,{recursive:true,force:true});});
  const headers={Authorization:`Bearer ${app.key}`};
  return {app,root,headers,async post(route,body={}) {
    const res=await fetch(app.url+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  }};
}
test('loopback bind, CSP and static UI; private helper may open main page',async t=>{
  const {app}=await server(t);assert.equal(app.server.address().address,'127.0.0.1');
  const res=await fetch(app.url,{headers:{'Sec-Fetch-Site':'cross-site'}});
  assert.equal(res.status,200);assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'),'DENY');assert.match(await res.text(),/Симулятор/);
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
  assert.equal((await fetch(app.url+'/api/asset?id=../../etc/passwd',{headers})).status,400);
  assert.equal((await fetch(app.url+'/src/service.cjs',{headers})).status,404);
  assert.equal((await fetch(app.url+'/api/result',{headers})).status,400);
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
  await assert.rejects(startServer({root,open:false}),/Не удалось проверить запущенное приложение/);
  assert.equal(await fsp.readFile(file,'utf8'),original);
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
