'use strict';
const net = require('node:net');
const { randomUUID } = require('node:crypto');

async function rpc(kind, command, args = {}, timeoutMs = 12000) {
  if (!['qmp', 'qga'].includes(kind)) throw new Error('Expected qmp or qga.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: kind === 'qmp' ? 14500 : 14501 });
    const id = randomUUID();
    let pending = '', sent = false;
    const deadline = setTimeout(() => finish(new Error(`${kind}: ${command} timed out.`)), timeoutMs);
    function finish(error, result) {
      clearTimeout(deadline); socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    function send(execute, argumentsValue, requestId) {
      socket.write(JSON.stringify({ execute, arguments: argumentsValue, id: requestId }) + '\n');
    }
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error(`${kind} connection closed.`)));
    socket.on('connect', () => {
      if (kind === 'qga') { sent = true; send(command, args, id); }
    });
    socket.on('data', bytes => {
      pending += bytes.toString('utf8').replace(/\u00ff/g, '');
      let cut;
      while ((cut = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, cut).trim(); pending = pending.slice(cut + 1);
        if (!line) continue;
        let data; try { data = JSON.parse(line); } catch { continue; }
        if (data.QMP) { send('qmp_capabilities', {}, 'capabilities'); continue; }
        if (data.id === 'capabilities') {
          if (data.error) return finish(new Error(JSON.stringify(data.error)));
          sent = true; send(command, args, id); continue;
        }
        if (!sent || data.event || (data.id && data.id !== id)) continue;
        if (data.error) return finish(new Error(JSON.stringify(data.error)));
        if ('return' in data) return finish(null, data.return);
      }
    });
  });
}
module.exports = { rpc };
if (require.main === module) {
  const [kind, command, value = '{}'] = process.argv.slice(2);
  if (!kind || !command) { console.error('Usage: node rpc.cjs qmp|qga COMMAND [JSON_ARGUMENTS]'); process.exitCode = 1; }
  else {
    let args; try { args = JSON.parse(value); } catch { console.error('Invalid JSON arguments.'); process.exitCode = 1; }
    if (args) rpc(kind, command, args).then(data => console.log(JSON.stringify(data)), error => { console.error(error.message); process.exitCode = 1; });
  }
}
