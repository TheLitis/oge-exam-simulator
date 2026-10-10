'use strict';
// Temporary, read-only transfer from the host into QEMU's user-mode network.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const files = new Map([
  ['/anaconda.ks', path.join(root, '.mos-testbed/anaconda.ks')],
  ['/oge-exam-source.zip', path.join(root, 'imported/chatgpt/oge-exam-source.zip')],
  ['/oge-exam-simulator-linux-x64.tar.gz', path.join(root, 'imported/chatgpt/oge-exam-simulator-linux-x64.tar.gz')]
]);
const server = http.createServer(async (req, res) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || !['127.0.0.1:13601', '10.0.2.2:13601'].includes(req.headers.host)) {
    res.writeHead(403); res.end(); return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const file = files.get(req.url);
  if (!file) { res.writeHead(404); res.end(); return; }
  try {
    const stat = await fs.promises.stat(file);
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(13601, '127.0.0.1', () => console.log('MOS installation payload: http://127.0.0.1:13601/'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
