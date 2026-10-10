'use strict';
const fs = require('node:fs');
const { rpc } = require('./rpc.cjs');
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

async function execute(script, timeoutMs = 60000) {
  const started = await rpc('qga', 'guest-exec', {
    path: '/bin/bash', arg: ['-s'], 'input-data': Buffer.from(script).toString('base64'), 'capture-output': true
  });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await rpc('qga', 'guest-exec-status', { pid: started.pid });
    if (state.exited) {
      return { pid: started.pid, exitCode: state.exitcode, signal: state.signal, stdout: Buffer.from(state['out-data'] || '', 'base64').toString('utf8'), stderr: Buffer.from(state['err-data'] || '', 'base64').toString('utf8'), outputTruncated: Boolean(state['out-truncated'] || state['err-truncated']) };
    }
    await sleep(300);
  }
  throw new Error(`Guest process ${started.pid} did not finish within ${timeoutMs} ms.`);
}
module.exports = { execute };
if (require.main === module) {
  const scriptPath = process.argv[2];
  if (!scriptPath) { console.error('Usage: node guest.cjs SCRIPT_FILE [TIMEOUT_MS]'); process.exitCode = 1; }
  else {
    const timeoutMs = Number(process.argv[3] || 60000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) { console.error('Timeout must be 1000..60000 ms.'); process.exitCode = 1; }
    else execute(fs.readFileSync(scriptPath, 'utf8'), timeoutMs).then(result => {
      console.log(JSON.stringify(result)); process.exitCode = result.exitCode === 0 ? 0 : 1;
    }, error => { console.error(error.message); process.exitCode = 1; });
  }
}
