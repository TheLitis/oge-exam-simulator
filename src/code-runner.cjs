'use strict';
// Only Linux x86_64 with working user namespaces and seccomp may execute code.
// There is deliberately no subprocess fallback when the sandbox is unavailable.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { safeName } = require('./io.cjs');
const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ sourceBytes: 256 * 1024, inputBytes: 64 * 1024, outputBytes: 64 * 1024,
  resourceBytes: 16 * MiB, totalResourceBytes: 32 * MiB, resources: 16,
  wallMs: 4000, cpuSeconds: 2, addressSpaceBytes: 1024 * MiB, fileBytes: MiB,
  processes: 512, openFiles: 64, queue: 32 });
let queue = Promise.resolve(), queued = 0, cached = null, probe = null;
const unavailable = (reason, message) => ({ status: 'unavailable', reason, message, stdout: '', stderr: '', limits: LIMITS });
const invalid = message => ({ status: 'error', reason: 'limit', message, stdout: '', stderr: '', limits: LIMITS });
const cleanEnv = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });

function utf8(value, max, label) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value))) throw new Error(`${label}: требуется текст UTF-8.`);
  if (Buffer.byteLength(value) > max) throw new Error(`${label}: превышен допустимый размер.`);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
  if (bytes.length > max || bytes.includes(0)) throw new Error(`${label}: превышен размер или найден нулевой байт.`);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${label}: требуется текст UTF-8.`); }
  return bytes;
}
function prepare(value) {
  if (!value || !['python', 'javascript'].includes(value.language)) throw new Error('Поддерживаются только Python 3 и JavaScript.');
  const source = utf8(value.source, LIMITS.sourceBytes, 'Программа');
  if (!source.length) throw new Error('Программа пуста.');
  const input = utf8(value.input ?? '', LIMITS.inputBytes, 'Входные данные');
  const resources = value.resources ?? [];
  if (!Array.isArray(resources) || resources.length > LIMITS.resources) throw new Error('Слишком много файлов условия.');
  const names = new Set(['source.py', 'source.js', 'source.cjs']);
  for (const resource of resources) {
    if (!resource || typeof resource.file !== 'string' || !path.isAbsolute(resource.file)) throw new Error('Некорректный файл условия.');
    const name = safeName(resource.name), key = name.toLowerCase();
    if (names.has(key)) throw new Error('Повторяющееся или служебное имя файла условия.');
    names.add(key);
  }
  return { language: value.language, source, input, resources: resources.map(item => ({ name: item.name, file: item.file })) };
}

// Linux x86_64 syscall numbers: arch/x86/entry/syscalls/syscall_64.tbl.
// Reject other architectures, x32 syscalls, network access, namespace changes,
// process creation and host inspection. Runtime pthreads need CLONE_THREAD.
function seccompFilter() {
  const instructions = [];
  const add = (code, jt, jf, k) => instructions.push({ code, jt, jf, k });
  const load = offset => add(0x20, 0, 0, offset);
  const ret = value => add(0x06, 0, 0, value);
  const deny = nr => { add(0x15, 0, 1, nr); ret(0x00050001); }; // EPERM
  load(4); add(0x15, 1, 0, 0xc000003e); ret(0x80000000);
  load(0); add(0x45, 0, 1, 0x40000000); ret(0x80000000);
  // Node uses getsockname/getsockopt for the anonymous stdio socketpairs made
  // by spawn. They cannot establish a connection; socket/connect/bind stay denied.
  for (const nr of [41,42,43,44,45,46,47,48,49,50,57,58,101,109,112,
    155,161,165,166,167,168,169,175,176,246,248,249,250,272,288,298,299,
    307,308,310,311,313,320,321,323,425,426,427,428,429,430,431,432,438,442]) deny(nr);
  add(0x15, 0, 1, 435); ret(0x00050026); // clone3: ENOSYS, libc falls back to clone.
  add(0x15, 0, 4, 53); // Anonymous AF_UNIX socketpairs for runtime message ports.
  load(16); add(0x15, 1, 0, 1); ret(0x00050001); ret(0x7fff0000);
  add(0x15, 0, 4, 56); // clone: only threads, never another process.
  load(16); add(0x45, 1, 0, 0x00010000); ret(0x00050001); ret(0x7fff0000);
  ret(0x7fff0000);
  const result = Buffer.alloc(instructions.length * 8);
  instructions.forEach((ins, index) => { const at = index * 8;
    result.writeUInt16LE(ins.code, at); result[at + 2] = ins.jt; result[at + 3] = ins.jf; result.writeUInt32LE(ins.k, at + 4); });
  return result;
}
async function executable(file) {
  try { await fsp.access(file, fs.constants.X_OK); return (await fsp.stat(file)).isFile(); } catch { return false; }
}
async function tools() {
  if (process.platform !== 'linux' || process.arch !== 'x64') return { reason: 'platform', message: 'Запуск программ доступен только в Linux x86_64 с безопасной изоляцией.' };
  // Refuse root: resource limits for unprivileged users must remain effective.
  if (!process.getuid || process.getuid() === 0) return { reason: 'sandbox', message: 'Запуск проверки от root запрещён.' };
  const bwrap = '/usr/bin/bwrap', prlimit = '/usr/bin/prlimit';
  if (!await executable(bwrap) || !await executable(prlimit)) return { reason: 'sandbox', message: 'Не найдены bubblewrap и prlimit. Требуется ручная проверка.' };
  const mounts = [];
  for (const dir of ['/usr/lib', '/usr/lib64', '/lib', '/lib64']) {
    try { if ((await fsp.stat(dir)).isDirectory()) mounts.push(dir); } catch {}
  }
  if (!mounts.length) return { reason: 'sandbox', message: 'Не найдены системные библиотеки для изоляции.' };
  return { bwrap, prlimit, mounts, python: await executable('/usr/bin/python3') ? '/usr/bin/python3' : null,
    javascript: await executable(process.execPath) ? process.execPath : null };
}
async function stageResource(resource, dest, remaining) {
  let handle;
  try {
    handle = await fsp.open(resource.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.resourceBytes || stat.size > remaining) throw new Error('Недопустимый или слишком большой файл условия.');
    const target = await fsp.open(dest, 'wx', 0o600);
    let total = 0;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > LIMITS.resourceBytes || total > remaining) throw new Error('Файл условия превышает допустимый размер.');
        await target.writeFile(buffer.subarray(0, bytesRead));
      }
    } finally { await target.close(); }
    return total;
  } finally { await handle?.close(); }
}
function sandboxArgs(config, work, language) {
  const runtime = language === 'python' ? config.python : config.javascript;
  const name = language === 'python' ? 'python3' : 'node';
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--clearenv', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'HOME', '/nonexistent', '--setenv', 'PATH', '/runtime', '--setenv', 'TMPDIR', '/nonexistent',
    '--dir', '/runtime', '--dir', '/work'];
  for (const dir of config.mounts) args.push('--ro-bind', dir, dir);
  if (fs.existsSync('/etc/ld.so.cache')) args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
  args.push('--ro-bind', runtime, '/runtime/' + name, '--ro-bind', work, '/work', '--proc', '/proc',
    '--remount-ro', '/proc', '--dev', '/dev', '--remount-ro', '/dev', '--remount-ro', '/',
    '--chdir', '/work', '--seccomp', '3', '--json-status-fd', '4', '--', '/runtime/' + name);
  if (language === 'python') args.push('-I', '-S', '-B', '-u', '/work/source.py');
  else args.push('--jitless', '--no-expose-wasm', '--max-old-space-size=64', '--no-addons', '/work/source.cjs');
  return ['--as=' + LIMITS.addressSpaceBytes, '--cpu=' + LIMITS.cpuSeconds + ':' + (LIMITS.cpuSeconds + 1),
    '--fsize=' + LIMITS.fileBytes, '--nproc=' + LIMITS.processes, '--nofile=' + LIMITS.openFiles,
    '--core=0', '--', config.bwrap, ...args];
}
async function execute(config, value) {
  const started = performance.now(); let root, filter;
  try {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oge-code-'));
    await fsp.chmod(root, 0o700);
    const work = path.join(root, 'work'); await fsp.mkdir(work, { mode: 0o700 });
    await fsp.writeFile(path.join(work, value.language === 'python' ? 'source.py' : 'source.cjs'), value.source, { flag: 'wx', mode: 0o600 });
    let total = 0;
    for (const resource of value.resources) total += await stageResource(resource, path.join(work, resource.name), LIMITS.totalResourceBytes - total);
    const filterFile = path.join(root, 'seccomp.bpf'); await fsp.writeFile(filterFile, seccompFilter(), { flag: 'wx', mode: 0o600 });
    filter = await fsp.open(filterFile, 'r');
    return await new Promise(resolve => {
      let output = 0, statusBytes = 0, outputExceeded = false, timedOut = false, spawnError = null;
      const out = [], err = [], metadata = [];
      const child = spawn(config.prlimit, sandboxArgs(config, work, value.language), {
        shell: false, detached: true, cwd: root, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe', filter.fd, 'pipe'] });
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, LIMITS.wallMs);
      const read = store => bytes => {
        const remaining = Math.max(0, LIMITS.outputBytes - output);
        if (remaining) store.push(bytes.subarray(0, remaining));
        output += bytes.length;
        if (output > LIMITS.outputBytes) { outputExceeded = true; kill(); }
      };
      child.stdout.on('data', read(out)); child.stderr.on('data', read(err));
      child.stdio[4].on('data', bytes => { statusBytes += bytes.length;
        if (statusBytes > 8192) { spawnError = new Error('Некорректный канал состояния изоляции.'); kill(); }
        else metadata.push(bytes); });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') { spawnError = error; kill(); } });
      child.on('error', error => { spawnError = error; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        const text = (chunks, max) => {
          const decoded = Buffer.concat(chunks).toString('utf8'), encoded = Buffer.from(decoded);
          if (encoded.length <= max) return decoded;
          // Invalid UTF-8 and a truncated final character must not expand the
          // returned strings beyond the byte limit after replacement decoding.
          return encoded.subarray(0, max).toString('utf8').replace(/\ufffd$/u, '');
        };
        let stdout = '', invalidStdout = false;
        try { stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(out)); }
        catch { invalidStdout = true; }
        const stderr = text(err, LIMITS.outputBytes - Buffer.byteLength(stdout));
        const result = { stdout, stderr,
          exitCode, signal, durationMs: Math.round(performance.now() - started), limits: LIMITS };
        let events;
        try { events = Buffer.concat(metadata).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
        catch { events = []; }
        const launched = events.some(event => Number.isInteger(event['child-pid']) && event['child-pid'] > 0);
        const reportedExit = events.find(event => Number.isInteger(event['exit-code']))?.['exit-code'];
        if (spawnError || !launched) resolve({ ...result, status: 'error', reason: 'infrastructure', message: 'Не удалось создать безопасную изоляцию.' });
        else if (timedOut || reportedExit === 152) resolve({ ...result, status: 'timeout', reason: 'limit', message: 'Превышено время выполнения.' });
        else if (outputExceeded) resolve({ ...result, status: 'error', reason: 'output', message: 'Программа вывела больше 64 КиБ.' });
        else if (reportedExit === undefined || reportedExit !== exitCode) resolve({ ...result, status: 'error', reason: 'infrastructure', message: 'Не удалось подтвердить завершение изолированной программы.' });
        else if (invalidStdout) resolve({ ...result, status: 'error', reason: 'output', message: 'Вывод программы содержит некорректный UTF-8.' });
        else if (exitCode !== 0 || signal) resolve({ ...result, status: 'error', reason: 'runtime', message: 'Программа завершилась с ошибкой.' });
        else resolve({ ...result, status: 'ok' });
      });
      child.stdin.end(value.input);
    });
  } catch (error) {
    return { status: 'error', reason: 'infrastructure', message: 'Не удалось подготовить изолированную проверку.',
      stdout: '', stderr: '', durationMs: Math.round(performance.now() - started), limits: LIMITS };
  } finally {
    await filter?.close();
    if (root) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
async function getCapabilities() {
  const config = await tools();
  const languages = { python: false, javascript: false };
  if (config.reason) return { available: false, languages, reason: config.reason, message: config.message, limits: LIMITS, config: null };
  for (const language of Object.keys(languages)) {
    if (!config[language]) continue;
    const source = Buffer.from(language === 'python' ? 'print("oge-sandbox-ready")\n' : 'process.stdout.write("oge-sandbox-ready\\n");\n');
    const result = await execute(config, { language, source, input: Buffer.alloc(0), resources: [] });
    languages[language] = result.status === 'ok' && result.stdout === 'oge-sandbox-ready\n';
  }
  const available = Object.values(languages).some(Boolean);
  return { available, languages, reason: available ? null : 'sandbox', message: available ? null : 'Безопасная изоляция недоступна. Требуется ручная проверка.', limits: LIMITS, config };
}
async function capabilityState() {
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  if (!probe) probe = getCapabilities().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { probe = null; });
  return probe;
}
async function capabilities() {
  const { config, ...publicState } = await capabilityState(); return publicState;
}
async function runCode(value) {
  let prepared;
  try { prepared = prepare(value); } catch (error) { return invalid(error.message); }
  if (queued >= LIMITS.queue) return unavailable('busy', 'Очередь проверки заполнена. Повторите проверку позже.');
  queued++;
  const job = queue.then(async () => {
    const state = await capabilityState();
    if (!state.available) return unavailable(state.reason, state.message);
    if (!state.languages[prepared.language]) return unavailable('runtime', 'Среда выбранного языка недоступна в безопасной изоляции.');
    return execute(state.config, prepared);
  });
  queue = job.catch(() => {});
  try { return await job; } catch { return unavailable('sandbox', 'Безопасная проверка временно недоступна.'); }
  finally { queued--; }
}
module.exports = { capabilities, runCode, LIMITS };
