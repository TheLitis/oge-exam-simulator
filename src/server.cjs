'use strict';
const http = require('node:http');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { fs, fsp, path, crypto, UserError, check, LIMITS, mkdir, atomic, json, readJson, boundedCopy, safeName } = require('./io.cjs');
const { ExamService } = require('./service.cjs');
const { PROJECT_LIMIT } = require('./teacher.cjs');
const { openFolder } = require('./desktop.cjs');

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
async function executable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, name); try { await fsp.access(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}
async function launch(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function openBrowser(file, { platform = process.platform, findExecutable = executable, launchProcess = launch } = {}) {
  // Process arguments must never contain the API capability. Only the private
  // file's contents navigate to the authenticated HTTP URL in the browser.
  const url = pathToFileURL(file).href;
  if (platform === 'linux') {
    for (const name of ['yandex-browser-stable', 'yandex-browser', 'chromium', 'chromium-browser', 'google-chrome-stable']) {
      const bin = await findExecutable(name); if (bin) { await launchProcess(bin, [`--app=${url}`]); return; }
    }
    const opener = await findExecutable('xdg-open'); if (opener) { await launchProcess(opener, [url]); return; }
  } else if (platform === 'darwin') { await launchProcess('/usr/bin/open', [url]); return; }
  else if (platform === 'win32') { await launchProcess('rundll32.exe', ['url.dll,FileProtocolHandler', url]); return; }
  throw new UserError('Не найден браузер. Откройте файл OPEN-IN-BROWSER.html в папке данных приложения.');
}
async function writeBrowserBootstrap(root, info) {
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) && /^[a-f0-9]{64}$/.test(info.key), 'Повреждён файл запущенного приложения.');
  const target = `${info.url}/#${info.key}`;
  // Older running builds have no browserId. A port-specific name remains safe
  // for that live instance without rewriting its connection record.
  const id = /^[a-f0-9-]{36}$/.test(info.browserId || '') ? info.browserId : `port-${new URL(info.url).port}`;
  const file = path.join(root, `OPEN-IN-BROWSER-${id}.html`);
  const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><meta http-equiv="refresh" content="0;url=${target}"><title>Открыть симулятор</title></head><body><a href="${target}">Открыть симулятор экзамена</a><p>Не передавайте этот файл другим пользователям.</p></body></html>`;
  // A separate instance file binds a requested automatic open even if a later
  // launch replaces the manual double-click helper in the same data directory.
  await atomic(file, page);
  await atomic(path.join(root, 'OPEN-IN-BROWSER.html'), page);
  return file;
}
async function defaultResultsDirectory() {
  let documents = path.join(os.homedir(), 'Documents');
  if (process.platform === 'linux') {
    const bin = await executable('xdg-user-dir');
    if (bin) {
      try {
        const { stdout } = await promisify(execFile)(bin, ['DOCUMENTS'], { encoding: 'utf8', timeout: 2000 });
        const configured = stdout.trim();
        if (path.isAbsolute(configured) && !configured.includes('\0')) documents = configured;
      } catch { /* Use a visible Documents folder if the desktop helper is unavailable. */ }
    }
  }
  return path.join(documents, 'Симулятор экзамена', 'Результаты');
}
async function bodyJson(req) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Ожидается JSON.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; check(size <= 65536, 'Слишком большой запрос.'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('Некорректный JSON.'); }
  check(value && typeof value === 'object' && !Array.isArray(value), 'Некорректный запрос.'); return value;
}
function reply(res, value, status = 200) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }); res.end(data);
}
async function sendFile(res, file, mime, name) {
  const stat = await fsp.stat(file); check(stat.isFile(), 'Файл не найден.');
  const headers = { 'Content-Type': mime, 'Content-Length': stat.size };
  if (name) headers['Content-Disposition'] = `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, x => '%' + x.charCodeAt(0).toString(16))}`;
  res.writeHead(200, headers); await pipeline(fs.createReadStream(file), res);
}
async function instanceResponds(info) {
  // A PID can be reused after a crash or an OS restart. Confirm that its saved
  // address still belongs to this authenticated service before opening it.
  return new Promise((resolve, reject) => {
    let request, settled = false;
    const unavailable = () => new UserError('Не удалось проверить запущенное приложение. Повторите запуск через несколько секунд.');
    const finish = (error, alive) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); request?.destroy();
      if (error) reject(error); else resolve(alive);
    };
    const timeout = setTimeout(() => finish(unavailable()), 2000);
    request = http.get(`${info.url}/api/health`, { headers: { Authorization: `Bearer ${info.key}` } }, res => {
      if ([400, 401, 403, 404].includes(res.statusCode)) return finish(null, false);
      if (res.statusCode !== 200) return finish(unavailable());
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 1024) finish(unavailable()); });
      res.on('error', () => finish(unavailable()));
      res.on('end', () => {
        let value; try { value = JSON.parse(data); } catch { return finish(unavailable()); }
        // Older builds returned only {ok:true}; their token still authenticates
        // this probe. New builds also identify the process that answered.
        if (value?.ok !== true) return finish(unavailable());
        finish(null, value.pid === undefined || value.pid === info.pid);
      });
    });
    request.on('error', e => finish(e.code === 'ECONNREFUSED' ? null : unavailable(), false));
  });
}

async function startServer({ root, resultsRoot, open = true, port = 0, lock = true, clock, browserLauncher = openBrowser, folderLauncher = openFolder, allowLegacyResults = false } = {}) {
  process.umask(0o077);
  const isolatedData = !!root;
  root ||= path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'oge-exam-simulator');
  root = path.resolve(root); await mkdir(root);
  const lockDir = path.join(root, 'instance.lock');
  if (lock) {
    try { await fsp.mkdir(lockDir, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info;
      for (let i = 0; i < 20; i++) {
        try { info = await readJson(path.join(lockDir, 'connection.json')); break; }
        catch { await new Promise(r => setTimeout(r, 100)); }
      }
      let alive = false;
      if (info?.pid) { try { process.kill(info.pid, 0); alive = true; } catch {} }
      if (alive) {
        check(/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) && /^[a-f0-9]{64}$/.test(info.key), 'Повреждён файл запущенного приложения.');
        if (await instanceResponds(info)) {
          const browserFile = await writeBrowserBootstrap(root, info);
          if (open) await browserLauncher(browserFile); return { existing: true, ...info };
        }
      }
      await fsp.rm(lockDir, { recursive: true, force: true }); await fsp.mkdir(lockDir, { mode: 0o700 });
    }
  }
  // Explicit --data runs stay isolated; normal desktop launches export to Documents.
  resultsRoot ||= isolatedData ? path.join(root, 'results') : await defaultResultsDirectory();
  const service = new ExamService(root, { ...clock, resultsRoot, allowLegacyResults });
  try { await service.init(); } catch (e) { if (lock) await fsp.rm(lockDir, { recursive: true, force: true }); throw e; }
  const key = crypto.randomBytes(32).toString('hex');
  let chain = Promise.resolve(), timer, base, browserFile, closing = false, uploads = 0;
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const publicFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js','text/javascript; charset=utf-8']], ['/views.js', ['views.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']], ['/icon.svg',['icon.svg','image/svg+xml']], ['/fonts/inter.ttf', ['fonts/inter.ttf', 'font/ttf']]]);
  async function close() {
    if (closing) return; closing = true; clearInterval(timer);
    await serial(() => service.pulse(true)).catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    if (browserFile) await fsp.rm(browserFile, { force: true }).catch(() => {});
    if (lock) await fsp.rm(lockDir, { recursive: true, force: true });
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    let temp;
    try {
      check(req.headers.host === new URL(base).host, 'Недопустимый Host.');
      const url = new URL(req.url, base);
      if (req.method === 'GET' && publicFiles.has(url.pathname)) {
        if (url.pathname === '/') {
          // Apply the saved appearance before CSS paints, including after a
          // restart on a different port. Only fixed theme names enter the HTML.
          const page = await fsp.readFile(path.join(__dirname, '../ui/index.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page.replace('data-theme="light"', `data-theme="${service.theme()}"`)); return;
        }
        const [name, type] = publicFiles.get(url.pathname); await sendFile(res, path.join(__dirname, '../ui', name), type); return;
      }
      // Public UI contains no session data. Allow opening its main page from
      // the private file:// launcher; protect every API route against cross-site requests.
      check(!req.headers.origin || req.headers.origin === base, 'Межсайтовые запросы запрещены.');
      check(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Межсайтовые запросы запрещены.');
      const expected = `Bearer ${key}`, supplied = req.headers.authorization || '';
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new UserError('Нет доступа. Запустите приложение через start.sh / ярлык, а не произвольный адрес.', 401);
      const teacherToken = req.headers['x-teacher-token'];
      const teacherAccess = () => service.teacherAuthorized(teacherToken);
      const requireTeacher = () => { if (!service.teacherConfigured() || !teacherAccess()) throw new UserError('Для этого действия войдите как преподаватель.', 403); };
      // Recheck within the service queue: a token may expire or be locked while
      // the request body is arriving or another request is changing the mode.
      const asTeacher = fn => serial(() => { requireTeacher(); return fn(); });
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return reply(res, { ok: true, value: await serial(async () => { await service.pulse(); return service.state({ teacherAccess: teacherAccess() }); }) });
        if (url.pathname === '/api/task') return reply(res, { ok: true, value: await serial(() => service.task(Number(url.searchParams.get('id')))) });
        if (url.pathname === '/api/asset') {
          const asset = await serial(async () => {
            await service.pulse();
            if (service.attempt?.status !== 'active') requireTeacher();
            return service.asset(url.searchParams.get('id'));
          });
          await sendFile(res, asset.file, asset.isImage ? asset.mime : 'application/octet-stream', asset.isImage && url.searchParams.get('download') !== '1' ? null : asset.name); return;
        }
        if (url.pathname === '/api/package') { const file = await asTeacher(() => service.exportFile(url.searchParams.get('id'))); await sendFile(res, file, 'application/zip', 'exam.oge'); return; }
        if (url.pathname === '/api/result') { const a = await serial(()=>service.resultDownload()); await sendFile(res,a.file,a.encrypted?'application/octet-stream':'application/zip',path.basename(a.file));return; }
        if (url.pathname === '/api/teacher/result-key') {const file=await asTeacher(()=>service.resultKeyBackup());await sendFile(res,file,'application/octet-stream','result-key.ogekeys');return;}
        if (url.pathname === '/api/review/report') {
          const report = await asTeacher(() => service.reviewReport(url.searchParams.get('id')));
          try { await sendFile(res, report.file || report, 'application/zip', 'reviewed-results.zip'); }
          finally { await report.cleanup?.(); }
          return;
        }
        if (url.pathname === '/api/health') return reply(res, { ok: true, pid: process.pid });
        throw new UserError('Не найдено.', 404);
      }
      check(req.method === 'POST', 'Недопустимый метод.');
      if (url.pathname === '/api/upload') {
        const kind = url.searchParams.get('kind'), name = url.searchParams.get('name'); safeName(name);
        check(['image', 'resource', 'answer', 'package', 'review','result-key'].includes(kind), 'Некорректный тип файла.');
        const editPackage = kind === 'package' && url.searchParams.get('edit') === '1';
        const teacherUpload = ['image', 'resource', 'review','result-key'].includes(kind) || editPackage;
        if (teacherUpload) requireTeacher();
        let projectPassword;
        if ((editPackage || kind==='result-key') && req.headers['x-project-password'] !== undefined) {
          const encoded = req.headers['x-project-password'];
          check(typeof encoded === 'string' && Buffer.byteLength(encoded) <= 1536, 'Некорректный пароль проекта.');
          try { projectPassword = decodeURIComponent(encoded); } catch { throw new UserError('Некорректный пароль проекта.'); }
          check(projectPassword.length > 0 && projectPassword.length <= 128 && !projectPassword.includes('\0'), 'Некорректный пароль проекта.');
        }
        check(uploads < 2, 'Дождитесь завершения предыдущей загрузки.');
        const limit = kind==='result-key'?256*1024:kind==='review'?require('./result-protection.cjs').RESULT_LIMIT:editPackage ? PROJECT_LIMIT : kind==='package' ? LIMITS.archive : kind === 'image' ? LIMITS.image : LIMITS.file;
        if (req.headers['content-length']) check(Number(req.headers['content-length']) <= limit, 'Файл превышает допустимый размер.');
        uploads++; temp = path.join(root, 'incoming', crypto.randomUUID());
        try {
          await boundedCopy(req, temp, limit);
          const id = Number(url.searchParams.get('task'));
          const applyUpload = () => kind === 'package' ? service.importExam(temp, editPackage, projectPassword)
            : kind==='result-key'?service.importResultKey(temp,projectPassword)
            : kind === 'review' ? service.importReview(temp)
            : kind === 'answer' ? service.attachFile(id, temp, name)
            : service.addEditorAsset(temp, name, id, kind, url.searchParams.get('auto') === '1');
          const result = await (teacherUpload ? asTeacher(applyUpload) : serial(applyUpload));
          reply(res, { ok: true, value: result });
        } finally { uploads--; }
        return;
      }
      const b = await bodyJson(req);
      let result;
      switch (url.pathname) {
        case '/api/teacher/setup': result = await serial(() => {
          if (service.teacherConfigured()) throw new UserError('Пароль преподавателя уже задан. Войдите с существующим паролем.', 409);
          return service.configureTeacher(b.password);
        }); break;
        case '/api/teacher/unlock': result = await serial(async () => {
          try { return await service.unlockTeacher(b.password); }
          catch (e) {
            if (!(e instanceof UserError)) throw e;
            if (e.status === 429 && Number.isFinite(e.retryAfter)) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(e.retryAfter))));
            throw new UserError(e.status === 429 ? 'Повторите вход через несколько секунд.' : 'Не удалось войти как преподаватель.', e.status);
          }
        }); break;
        case '/api/teacher/lock': result = await asTeacher(async () => { await service.lockTeacher(); return true; }); break;
        case '/api/theme': result = await serial(() => service.setTheme(b.theme)); break;
        case '/api/editor/new': result = await asTeacher(() => service.newEditor()); break;
        case '/api/editor/update': result = await asTeacher(() => service.updateEditor(b)); break;
        case '/api/editor/checker': result = await asTeacher(() => service.setEditorChecker(b)); break;
        case '/api/editor/reference-preview': result = await asTeacher(async () => { const preview=await service.previewReference(b); requireTeacher(); return preview; }); break;
        case '/api/review/check': result = await asTeacher(() => service.checkReview(b)); break;
        case '/api/editor/remove': result = await asTeacher(() => service.removeEditorAsset(b.id)); break;
        case '/api/editor/export': result = await asTeacher(() => service.exportExam(b.publish)); break;
        case '/api/demo': result = await (b.edit === true ? asTeacher(() => service.importExam(path.join(__dirname, '../examples/demo.oge'), true)) : serial(() => service.importExam(path.join(__dirname, '../examples/demo.oge')))); break;
        case '/api/start': result = await serial(() => service.start(b.candidate, b.code)); break;
        case '/api/navigate': result = await serial(() => service.navigate(b.id)); break;
        case '/api/draft': result = await serial(() => service.saveDraft(b.id, b.text)); break;
        case '/api/save': result = await serial(() => service.saveAnswer(b.id, b.text)); break;
        case '/api/clear': result = await serial(() => service.clearAnswer(b.id)); break;
        case '/api/finish': check(b.confirm === true, 'Необходимо подтвердить завершение.'); result = await serial(() => service.finish('manual')); break;
        case '/api/export/retry': result = await serial(() => service.exportResults()); break;
        case '/api/dismiss': result = await serial(() => service.dismissResult()); break;
        case '/api/open-folder': result = await serial(async () => {
          const ownResult=b.root!==true && service.attempt?.status==='finished' && service.attempt.resultDir;
          await folderLauncher(ownResult || service.resultsRoot); return true;
        }); break;
        case '/api/quit': check(b.confirm === true, 'Необходимо подтверждение.'); result = true; res.once('finish', () => setTimeout(() => close().catch(() => {}), 100)); break;
        default: throw new UserError('Не найдено.', 404);
      }
      reply(res, { ok: true, value: result });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        const msg = e instanceof UserError ? e.message : e.code === 'ENOENT' ? 'Файл не найден. Проверьте, что он не был перемещён.' : `Не удалось выполнить действие (${e.code || 'ошибка данных'}). Сохранённые ответы не удалены.`;
        const error = { ok: false, error: msg };
        if (e instanceof UserError && ['PROJECT_PASSWORD_REQUIRED', 'PROJECT_PASSWORD_INVALID','RESULT_KEY_PASSWORD_REQUIRED','RESULT_KEY_PASSWORD_INVALID','RESULT_KEY_REQUIRED','RESULT_INVALID'].includes(e.code)) error.code = e.code;
        reply(res, error, e instanceof UserError ? e.status : 500);
      }
    } finally { if (temp) await fsp.rm(temp, { force: true }).catch(() => {}); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const info = { pid: process.pid, url: base, key, browserId: crypto.randomUUID() };
    if (lock) await json(path.join(lockDir, 'connection.json'), info);
    // This PRIVATE helper contains a local access token. It is never included in results or Git.
    browserFile = await writeBrowserBootstrap(root, info);
    timer = setInterval(() => { serial(() => service.pulse()).catch(() => { service.lastError = 'Не удалось записать контрольную точку. Проверьте свободное место и права доступа; сообщите организатору.'; }); }, 500);
    if (open) { try { await browserLauncher(browserFile); } catch (e) { console.error(e.message); } }
    return { service, server, url: base, key, close, serial, root };
  } catch (e) { if (lock) await fsp.rm(lockDir, { recursive: true, force: true }); throw e; }
}
if (require.main === module) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  startServer({ root: value('--data'), resultsRoot: value('--results-dir'), open: !args.includes('--no-open'), port: Number(value('--port') || 0) }).then(instance => {
    if (instance.existing) return;
    console.log(`Симулятор экзамена запущен: ${instance.url} (доступ только с этого компьютера).`);
    for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => instance.close().then(() => process.exit(0)));
  }).catch(e => { console.error(`Ошибка запуска: ${e.message}`); process.exitCode = 1; });
}
module.exports = { startServer, openBrowser, CSP };
