'use strict';

// Runtime packages belong to .mos-testbed/tools/console, outside the app.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseArgs } = require('node:util');

const HOST = '127.0.0.1';
const PORT = 13600;
const ORIGIN = `http://${HOST}:${PORT}`;
const DEFAULT_RUNTIME = path.resolve(__dirname, '../../.mos-testbed/tools/console');

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      'runtime-root': { type: 'string', default: DEFAULT_RUNTIME },
      'vnc-port': { type: 'string', default: '15900' },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });
  if (!/^\d{1,5}$/.test(values['vnc-port'])) throw new Error('Invalid --vnc-port.');
  const vncPort = Number(values['vnc-port']);
  if (vncPort < 1 || vncPort > 65535) throw new Error('--vnc-port must be 1..65535.');
  return {
    runtimeRoot: path.resolve(values['runtime-root']),
    vncPort,
    help: Boolean(values.help)
  };
}

function requestPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url.split('?')[0]);
  } catch {
    return null;
  }
  // Reject Windows separators/alternate streams, controls and dot segments before
  // path resolution. Do not normalize away a traversal attempt with URL().
  if (/[\\:\x00-\x20\x7f#]/.test(decoded)) return null;
  if (decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded;
}

function isInsideRoot(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isLocalRequest(request) {
  return request.socket.remoteAddress === HOST && request.headers.host === `${HOST}:${PORT}`;
}

function loadPackages(runtimeRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'console-package.json'), 'utf8'));
  const roots = {};
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const root = fs.realpathSync(path.join(runtimeRoot, 'node_modules', ...name.split('/')));
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (installed.name !== name || installed.version !== version) {
      throw new Error(`Expected ${name}@${version} in ${runtimeRoot}/node_modules.`);
    }
    roots[name] = root;
  }
  // Absolute resolution prevents silently using app/global node_modules.
  const ws = require(path.join(roots.ws, 'index.js'));
  return { ws, noVncRoot: roots['@novnc/novnc'] };
}

function startConsole(options) {
  const { ws: { WebSocketServer, createWebSocketStream, WebSocket }, noVncRoot } = loadPackages(options.runtimeRoot);
  const html = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8');
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('binary') ? 'binary' : false
  });

  function reply(request, response, code, body, contentType = 'text/plain; charset=utf-8', nonce = '') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    response.writeHead(code, {
      'Content-Type': contentType,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
        `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
        `connect-src 'self' ws://${HOST}:${PORT}`,
        "img-src 'self' data: blob:",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'"
      ].join('; ')
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  }

  async function serve(request, response) {
    if (!isLocalRequest(request) || (request.headers.origin && request.headers.origin !== ORIGIN)) {
      reply(request, response, 403, 'Forbidden');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(request, response, 405, 'Method not allowed');
      return;
    }
    const pathname = requestPath(request.url);
    if (!pathname) {
      reply(request, response, 400, 'Invalid path');
      return;
    }
    if (pathname === '/' || pathname === '/console.html') {
      const nonce = randomBytes(18).toString('base64');
      reply(request, response, 200, html.replaceAll('__CONSOLE_NONCE__', nonce), 'text/html; charset=utf-8', nonce);
      return;
    }
    if (pathname === '/health') {
      // Console availability only: this does not claim the guest has booted.
      reply(request, response, 200, JSON.stringify({ status: 'ready', vnc: `${HOST}:${options.vncPort}` }), 'application/json; charset=utf-8');
      return;
    }
    if (pathname === '/favicon.ico') {
      reply(request, response, 204, '');
      return;
    }
    if (!/^\/novnc\/(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(pathname)) {
      reply(request, response, 404, 'Not found');
      return;
    }
    const candidate = path.resolve(noVncRoot, pathname.slice('/novnc/'.length));
    if (!isInsideRoot(noVncRoot, candidate)) {
      reply(request, response, 403, 'Forbidden');
      return;
    }
    try {
      // A symlink inside node_modules must not expose files outside the package.
      const realFile = await fs.promises.realpath(candidate);
      if (!isInsideRoot(noVncRoot, realFile)) {
        reply(request, response, 403, 'Forbidden');
        return;
      }
      const data = await fs.promises.readFile(realFile);
      reply(request, response, 200, data, 'text/javascript; charset=utf-8');
    } catch (error) {
      reply(request, response, error.code === 'ENOENT' ? 404 : 500, 'Unable to read resource');
    }
  }

  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000 }, (request, response) => {
    serve(request, response).catch(error => {
      console.error(`Console HTTP error: ${error.message}`);
      if (!response.headersSent) reply(request, response, 500, 'Internal error');
      else response.destroy();
    });
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    // Browser WebSockets always send Origin. Missing/null or foreign origins are
    // rejected, and Host is exact to prevent DNS rebinding against loopback.
    if (!isLocalRequest(request) || request.headers.origin !== ORIGIN) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (requestPath(request.url) !== '/websockify') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });

  wss.on('connection', client => {
    const upstream = net.createConnection({ host: HOST, port: options.vncPort });
    const tunnel = createWebSocketStream(client);
    const timeout = setTimeout(() => upstream.destroy(new Error('VNC connection timeout')), 5000);
    timeout.unref();
    upstream.once('connect', () => clearTimeout(timeout));
    upstream.once('close', () => {
      clearTimeout(timeout);
      if (client.readyState === WebSocket.OPEN) client.close(1000, 'VNC connection closed');
    });
    upstream.on('error', error => {
      console.error(`VNC ${HOST}:${options.vncPort}: ${error.code || error.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'VNC unavailable');
    });
    client.on('close', () => {
      upstream.destroy();
      tunnel.destroy();
    });
    client.on('error', () => upstream.destroy());
    tunnel.on('error', () => upstream.destroy());
    // Node streams preserve the RFB bytes and provide backpressure in both directions.
    upstream.pipe(tunnel);
    tunnel.pipe(upstream);
  });

  server.on('error', error => {
    console.error(`Cannot start console at ${ORIGIN}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`MOS OS VM console: ${ORIGIN}/`);
    console.log(`VNC target: ${HOST}:${options.vncPort}`);
  });
  const shutdown = () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/mos/console.cjs [--runtime-root <directory>] [--vnc-port <port>]');
      console.log(`HTTP/WebSocket: ${ORIGIN}/ (loopback only)`);
      console.log(`Default runtime root: ${DEFAULT_RUNTIME}`);
      console.log('Default VNC: 127.0.0.1:15900');
    } else {
      startConsole(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseOptions, requestPath, isInsideRoot };
