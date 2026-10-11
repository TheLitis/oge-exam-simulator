'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { capabilities, runCode, LIMITS } = require('../src/code-runner.cjs');

test('runner rejects non-UTF8, NUL, empty programs and unsupported languages before execution', async () => {
  for (const value of [
    { language: 'python', source: Buffer.from([0xc3, 0x28]) },
    { language: 'python', source: 'print(1)\0' },
    { language: 'python', source: '' },
    { language: 'shell', source: 'echo 1' },
    { language: 'python', source: 'print(1)', input: 'a\0' },
  ]) {
    const result = await runCode(value); assert.equal(result.status, 'error'); assert.equal(result.reason, 'limit');
  }
});
test('runner bounds source, input and resource names/count without spawning', async () => {
  for (const value of [
    { language: 'python', source: Buffer.alloc(LIMITS.sourceBytes + 1, 65) },
    { language: 'python', source: 'print(1)', input: 'x'.repeat(LIMITS.inputBytes + 1) },
    { language: 'python', source: 'print(1)', resources: [{ name: '../secret', file: path.resolve('secret') }] },
    { language: 'python', source: 'print(1)', resources: [{ name: 'source.py', file: path.resolve('secret') }] },
    { language: 'python', source: 'print(1)', resources: Array.from({ length: LIMITS.resources + 1 }, (_, n) => ({ name: n + '.txt', file: path.resolve(n + '.txt') })) },
  ]) { const result = await runCode(value); assert.equal(result.status, 'error'); assert.equal(result.reason, 'limit'); }
});
test('unsupported host fails closed rather than executing submitted code', { skip: process.platform === 'linux' && process.arch === 'x64' && process.getuid?.() !== 0 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oge-runner-closed-'));
  const marker = path.join(root, 'should-not-exist');
  try {
    const state = await capabilities(); assert.equal(state.available, false);
    const result = await runCode({ language: 'javascript', source: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');` });
    assert.equal(result.status, 'unavailable'); await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Linux sandbox enforces filesystem, network, process and execution limits', { timeout: 45000,
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 }, async t => {
  const state = await capabilities();
  if (!state.available) {
    assert.notEqual(process.env.OGE_SANDBOX_REQUIRED, '1', 'Required sandbox must be available on the MOS stand.');
    t.skip('bubblewrap/prlimit or unprivileged namespaces are unavailable'); return;
  }
  assert.equal(state.languages.python, true); assert.equal(state.languages.javascript, true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oge-runner-test-'));
  const secret = path.join(root, 'teacher-secret.txt'), resource = path.join(root, 'input.txt');
  try {
    await fs.writeFile(secret, 'DO-NOT-EXPOSE'); await fs.writeFile(resource, '41\n');
    await t.test('both supported languages read stdin and only explicitly supplied resource files', async () => {
      const py = await runCode({ language: 'python', source: 'print(int(input()) + int(open("input.txt").read()))', input: '1\n', resources: [{ name: 'input.txt', file: resource }] });
      assert.equal(py.status, 'ok', JSON.stringify(py)); assert.equal(py.stdout, '42\n');
      const js = await runCode({ language: 'javascript', source: 'const fs=require("fs"); console.log(Number(fs.readFileSync(0,"utf8"))+Number(fs.readFileSync("input.txt","utf8")));', input: '1\n', resources: [{ name: 'input.txt', file: resource }] });
      assert.equal(js.status, 'ok', JSON.stringify(js)); assert.equal(js.stdout, '42\n');
    });
    await t.test('home, host temp files, network sockets, forks and inherited control FDs are inaccessible', async () => {
      const source = `import os,socket,json\nresults=[]\nfor name in [${JSON.stringify(secret)}, '/home', '/etc/passwd', '/work/new-file']:\n try:\n  open(name, 'w' if name.endswith('new-file') else 'r').close(); results.append('bad')\n except OSError: results.append('blocked')\nfor action in [lambda: socket.socket(), lambda: os.fork(), lambda: os.setsid(), lambda: os.fstat(3), lambda: os.fstat(4)]:\n try: action(); results.append('bad')\n except OSError: results.append('blocked')\nprint(json.dumps(results))\n`;
      const result = await runCode({ language: 'python', source }); assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.stdout), Array(9).fill('blocked'));
      assert.equal(await fs.readFile(secret, 'utf8'), 'DO-NOT-EXPOSE');
    });
    await t.test('source errors remain student runtime errors, distinct from infrastructure', async () => {
      const result = await runCode({ language: 'python', source: 'raise ValueError("student failure")' });
      assert.equal(result.status, 'error'); assert.equal(result.reason, 'runtime'); assert.match(result.stderr, /student failure/);
    });
    await t.test('unused kernel IPC operations are denied before argument handling', async () => {
      // Invalid IDs/pointers and no creation flags: this check allocates no IPC objects.
      const source = 'import ctypes,errno\nlibc=ctypes.CDLL(None,use_errno=True)\nlibc.syscall.restype=ctypes.c_long\nfor nr in [29,30,31,64,65,66,67,68,69,70,71,220,240,241,242,243,244,245]:\n ctypes.set_errno(0)\n result=libc.syscall(nr,ctypes.c_long(-1),0,0,0,0,0)\n assert result==-1 and ctypes.get_errno()==errno.EPERM, (nr,result,ctypes.get_errno())\nprint("blocked")\n';
      const result = await runCode({ language: 'python', source });
      assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.stdout, 'blocked\n');
    });
    await t.test('infinite loops time out and a subsequent run succeeds', async () => {
      const result = await runCode({ language: 'python', source: 'while True: pass' });
      assert.equal(result.status, 'timeout', JSON.stringify(result)); assert.ok(result.durationMs < LIMITS.wallMs + 2500);
      const next = await runCode({ language: 'python', source: 'print(42)' }); assert.equal(next.status, 'ok'); assert.equal(next.stdout, '42\n');
    });
    await t.test('wall time terminates sleeping runtime threads and does not block later jobs', async () => {
      const result = await runCode({ language: 'python', source: 'import threading,time\nthreading.Thread(target=lambda: time.sleep(30)).start()\n' });
      assert.equal(result.status, 'timeout', JSON.stringify(result)); assert.ok(result.durationMs < LIMITS.wallMs + 2500);
      const next = await runCode({ language: 'javascript', source: 'console.log(42)' }); assert.equal(next.status, 'ok'); assert.equal(next.stdout, '42\n');
    });
    await t.test('JavaScript cannot start a subprocess or a network connection', async () => {
      const source = 'const assert=require("assert");const child=require("child_process").spawnSync("/runtime/node",["-e","console.log(1)"]);assert.equal(child.error.code,"EPERM"); const socket=require("net").connect(80,"127.0.0.1");socket.on("error",()=>console.log("blocked"));';
      const result = await runCode({ language: 'javascript', source }); assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.stdout, 'blocked\n');
    });
    await t.test('stdout and stderr are jointly bounded', async () => {
      const result = await runCode({ language: 'python', source: 'import sys\nsys.stdout.write("x" * 1000000)\nsys.stdout.flush()' });
      assert.equal(result.status, 'error'); assert.equal(result.reason, 'output');
      assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= LIMITS.outputBytes);
      const invalidUtf8 = await runCode({ language: 'python', source: 'import sys\nsys.stdout.buffer.write(bytes([255]) * 100000)\nsys.stdout.flush()' });
      assert.equal(invalidUtf8.reason, 'output');
      assert.ok(Buffer.byteLength(invalidUtf8.stdout) + Buffer.byteLength(invalidUtf8.stderr) <= LIMITS.outputBytes);
    });
    await t.test('invalid UTF-8 stdout cannot become a matching replacement character; stderr stays readable', async () => {
      const result = await runCode({ language: 'python', source: 'import sys\nsys.stdout.buffer.write(bytes([255]))\nsys.stdout.flush()' });
      assert.equal(result.status, 'error'); assert.equal(result.reason, 'output'); assert.equal(result.stdout, '');
      assert.match(result.message, /UTF-8/);
      const valid = await runCode({ language: 'python', source: 'print(chr(65533))' });
      assert.equal(valid.status, 'ok'); assert.equal(valid.stdout, '\ufffd\n');
      const stderr = await runCode({ language: 'python', source: 'import sys\nsys.stderr.buffer.write(bytes([255]))\nprint(42)' });
      assert.equal(stderr.status, 'ok'); assert.equal(stderr.stdout, '42\n'); assert.equal(stderr.stderr, '\ufffd');
      assert.ok(Buffer.byteLength(stderr.stdout) + Buffer.byteLength(stderr.stderr) <= LIMITS.outputBytes);
    });
    await t.test('memory allocation is bounded and resource symlinks are rejected', async () => {
      const result = await runCode({ language: 'python', source: 'a=bytearray(2*1024*1024*1024)' });
      assert.equal(result.status, 'error'); assert.equal(result.reason, 'runtime'); assert.match(result.stderr, /MemoryError/);
      await fs.symlink(resource, path.join(root, 'link.txt'));
      const linked = await runCode({ language: 'python', source: 'print(42)', resources: [{ name: 'link.txt', file: path.join(root, 'link.txt') }] });
      assert.equal(linked.status, 'error'); assert.equal(linked.reason, 'infrastructure');
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
