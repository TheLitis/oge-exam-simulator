'use strict';
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { fs, fsp, path, crypto, UserError, check, LIMITS, mkdir, json, readJson, boundedCopy, safeName } = require('./io.cjs');
const { ExamService } = require('./service.cjs');

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
async function openBrowser(url) {
  if (process.platform === 'linux') {
    for (const name of ['yandex-browser-stable', 'yandex-browser', 'chromium', 'chromium-browser', 'google-chrome-stable']) {
      const bin = await executable(name); if (bin) { await launch(bin, [`--app=${url}`]); return; }
    }
    const opener = await executable('xdg-open'); if (opener) { await launch(opener, [url]); return; }
  } else if (process.platform === 'darwin') { await launch('/usr/bin/open', [url]); return; }
  else if (process.platform === 'win32') { await launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]); return; }
  throw new UserError('Не найден браузер. Откройте файл OPEN-IN-BROWSER.html в папке данных приложения.');
}
async function openFolder(folder) {
  if (process.platform === 'linux') { const bin = await executable('xdg-open'); check(bin, 'Не найден xdg-open. Путь к результатам показан на экране.'); await launch(bin, [folder]); }
  else if (process.platform === 'darwin') await launch('/usr/bin/open', [folder]);
  else await launch('explorer.exe', [folder]);
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

async function startServer({ root, open = true, port = 0, lock = true, clock } = {}) {
  process.umask(0o077);
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
        if (open) await openBrowser(`${info.url}/#${info.key}`); return { existing: true, ...info };
      }
      await fsp.rm(lockDir, { recursive: true, force: true }); await fsp.mkdir(lockDir, { mode: 0o700 });
    }
  }
  const service = new ExamService(root, clock);
  try { await service.init(); } catch (e) { if (lock) await fsp.rm(lockDir, { recursive: true, force: true }); throw e; }
  const key = crypto.randomBytes(32).toString('hex');
  let chain = Promise.resolve(), timer, base, closing = false, uploads = 0;
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const publicFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js','text/javascript; charset=utf-8']], ['/views.js', ['views.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']], ['/icon.svg',['icon.svg','image/svg+xml']]]);
  async function close() {
    if (closing) return; closing = true; clearInterval(timer);
    await serial(() => service.pulse(true)).catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
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
        const [name, type] = publicFiles.get(url.pathname); await sendFile(res, path.join(__dirname, '../ui', name), type); return;
      }
      // Public UI contains no session data. Allow opening its main page from
      // the private file:// launcher; protect every API route against cross-site requests.
      check(!req.headers.origin || req.headers.origin === base, 'Межсайтовые запросы запрещены.');
      check(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Межсайтовые запросы запрещены.');
      const expected = `Bearer ${key}`, supplied = req.headers.authorization || '';
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new UserError('Нет доступа. Запустите приложение через start.sh / ярлык, а не произвольный адрес.', 401);
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return reply(res, { ok: true, value: await serial(async () => { await service.pulse(); return service.state(); }) });
        if (url.pathname === '/api/task') return reply(res, { ok: true, value: await serial(() => service.task(Number(url.searchParams.get('id')))) });
        if (url.pathname === '/api/asset') {
          const asset = await serial(() => service.asset(url.searchParams.get('id')));
          await sendFile(res, asset.file, asset.isImage ? asset.mime : 'application/octet-stream', asset.isImage && url.searchParams.get('download') !== '1' ? null : asset.name); return;
        }
        if (url.pathname === '/api/package') { const file = await serial(() => service.exportFile(url.searchParams.get('id'))); await sendFile(res, file, 'application/zip', 'exam.oge'); return; }
        if (url.pathname === '/api/result') { const a = service.attempt; check(a?.status === 'finished' && a.archivePath, 'Итоговый ZIP пока недоступен.'); await sendFile(res, a.archivePath, 'application/zip', path.basename(a.archivePath)); return; }
        if (url.pathname === '/api/health') return reply(res, { ok: true });
        throw new UserError('Не найдено.', 404);
      }
      check(req.method === 'POST', 'Недопустимый метод.');
      if (url.pathname === '/api/upload') {
        const kind = url.searchParams.get('kind'), name = url.searchParams.get('name'); safeName(name);
        check(['image', 'resource', 'answer', 'package'].includes(kind), 'Некорректный тип файла.');
        check(uploads < 2, 'Дождитесь завершения предыдущей загрузки.');
        const limit = kind === 'package' ? LIMITS.archive : kind === 'image' ? LIMITS.image : LIMITS.file;
        if (req.headers['content-length']) check(Number(req.headers['content-length']) <= limit, 'Файл превышает допустимый размер.');
        uploads++; temp = path.join(root, 'incoming', crypto.randomUUID());
        try {
          await boundedCopy(req, temp, limit);
          const id = Number(url.searchParams.get('task'));
          const result = await serial(() => kind === 'package' ? service.importExam(temp, url.searchParams.get('edit') === '1')
            : kind === 'answer' ? service.attachFile(id, temp, name)
            : service.addEditorAsset(temp, name, id, kind, url.searchParams.get('auto') === '1'));
          reply(res, { ok: true, value: result });
        } finally { uploads--; }
        return;
      }
      const b = await bodyJson(req);
      let result;
      switch (url.pathname) {
        case '/api/editor/new': result = await serial(() => service.newEditor()); break;
        case '/api/editor/update': result = await serial(() => service.updateEditor(b)); break;
        case '/api/editor/remove': result = await serial(() => service.removeEditorAsset(b.id)); break;
        case '/api/editor/export': result = await serial(() => service.exportExam(b.publish)); break;
        case '/api/demo': result = await serial(() => service.importExam(path.join(__dirname, '../examples/demo.oge'), b.edit === true)); break;
        case '/api/start': result = await serial(() => service.start(b.candidate, b.code)); break;
        case '/api/navigate': result = await serial(() => service.navigate(b.id)); break;
        case '/api/draft': result = await serial(() => service.saveDraft(b.id, b.text)); break;
        case '/api/save': result = await serial(() => service.saveAnswer(b.id, b.text)); break;
        case '/api/clear': result = await serial(() => service.clearAnswer(b.id)); break;
        case '/api/finish': check(b.confirm === true, 'Необходимо подтвердить завершение.'); result = await serial(() => service.finish('manual')); break;
        case '/api/export/retry': result = await serial(() => service.exportResults()); break;
        case '/api/dismiss': result = await serial(() => service.dismissResult()); break;
        case '/api/open-folder': await openFolder(service.attempt?.resultDir || service.dir('results')); result = true; break;
        case '/api/quit': check(b.confirm === true, 'Необходимо подтверждение.'); result = true; res.once('finish', () => setTimeout(() => close().catch(() => {}), 100)); break;
        default: throw new UserError('Не найдено.', 404);
      }
      reply(res, { ok: true, value: result });
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        const msg = e instanceof UserError ? e.message : e.code === 'ENOENT' ? 'Файл не найден. Проверьте, что он не был перемещён.' : `Не удалось выполнить действие (${e.code || 'ошибка данных'}). Сохранённые ответы не удалены.`;
        reply(res, { ok: false, error: msg }, e instanceof UserError ? e.status : 500);
      }
    } finally { if (temp) await fsp.rm(temp, { force: true }).catch(() => {}); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const info = { pid: process.pid, url: base, key };
    if (lock) await json(path.join(lockDir, 'connection.json'), info);
    // This PRIVATE helper contains a local access token. It is never included in results or Git.
    await fsp.writeFile(path.join(root, 'OPEN-IN-BROWSER.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Открыть симулятор</title><a href="${base}/#${key}">Открыть симулятор экзамена</a><p>Не передавайте этот файл другим пользователям.</p></html>`, { mode: 0o600 });
    timer = setInterval(() => { serial(() => service.pulse()).catch(() => { service.lastError = 'Не удалось записать контрольную точку. Проверьте свободное место и права доступа; сообщите организатору.'; }); }, 500);
    if (open) { try { await openBrowser(`${base}/#${key}`); } catch (e) { console.error(e.message); } }
    return { service, server, url: base, key, close, serial, root };
  } catch (e) { if (lock) await fsp.rm(lockDir, { recursive: true, force: true }); throw e; }
}
if (require.main === module) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  startServer({ root: value('--data'), open: !args.includes('--no-open'), port: Number(value('--port') || 0) }).then(instance => {
    if (instance.existing) return;
    console.log(`Симулятор экзамена запущен: ${instance.url} (доступ только с этого компьютера).`);
    for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => instance.close().then(() => process.exit(0)));
  }).catch(e => { console.error(`Ошибка запуска: ${e.message}`); process.exitCode = 1; });
}
module.exports = { startServer, CSP };
