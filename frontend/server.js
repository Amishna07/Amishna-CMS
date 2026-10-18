'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const publicRoot = path.join(__dirname, 'public');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.json':'application/json; charset=utf-8'};
const fail = (res, status, code, message) => {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...securityHeaders});
  res.end(JSON.stringify({error:{code,message}}));
};
const securityHeaders={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

function createFrontendServer({apiTarget = process.env.API_TARGET || 'http://127.0.0.1:4000', publicDirectory = publicRoot} = {}) {
  const target = new URL(apiTarget);
  if (!['http:','https:'].includes(target.protocol)) throw new Error('API_TARGET must use http or https');
  const root = fs.realpathSync(publicDirectory);
  const server = http.createServer((req,res) => {
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host||'')) return fail(res,403,'LOCAL_HOST_REQUIRED','Use the local frontend address.');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return fail(res,400,'INVALID_PATH','Invalid request path.'); }
    // fs.stat throws synchronously for NUL bytes. Reject decoded control bytes
    // before any filesystem call so malformed public requests cannot stop Node.
    if (/[\u0000-\u001f\u007f]/.test(pathname)) return fail(res,400,'INVALID_PATH','Invalid request path.');
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      // Require the actual frontend origin so another local web app cannot
      // submit changes to this workspace.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return fail(res,403,'ORIGIN_NOT_ALLOWED','Access this API through the local dashboard.');
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request({protocol:target.protocol,hostname:target.hostname,port:target.port,method:req.method,path:req.url,headers:{...req.headers,host:target.host},timeout:120000}, reply => {
        if (res.destroyed || res.writableEnded) { reply.destroy(); return; }
        reply.on('error', () => fail(res,503,'BACKEND_UNAVAILABLE','The local server response was interrupted. Try again.'));
        res.writeHead(reply.statusCode, {...reply.headers,'Cache-Control':'no-store',...securityHeaders});
        reply.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('API timeout')));
      upstream.on('error', () => fail(res,503,'BACKEND_UNAVAILABLE','The local server is unavailable. Start the application and try again.'));
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
      return;
    }
    if (!['GET','HEAD'].includes(req.method)) return fail(res,405,'METHOD_NOT_ALLOWED','Use GET or HEAD for frontend files.');
    const file = pathname === '/' ? path.join(root,'index.html') : path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || pathname.split(/[\\/]/).some(part=>part.startsWith('.')) || !types[path.extname(file)]) return fail(res,404,'NOT_FOUND','File not found.');
    const serveFile = () => fs.realpath(file, (resolveError, resolved) => {
      // Follow public asset links only when their real target stays public.
      if (resolveError || !resolved.startsWith(root + path.sep) || path.extname(resolved) !== path.extname(file) || path.relative(root, resolved).split(path.sep).some(part => part.startsWith('.'))) return fail(res,404,'NOT_FOUND','File not found.');
      fs.stat(resolved,(error,stat) => {
      if (error || !stat.isFile()) return fail(res,404,'NOT_FOUND','File not found.');
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, {'Content-Type':types[path.extname(file)],'Content-Length':stat.size,'Cache-Control':path.extname(file)==='.xlsx'?'no-store':'no-cache',...securityHeaders});
      if (req.method === 'HEAD') return res.end();
      const stream=fs.createReadStream(resolved);stream.on('error',()=>res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      });
    });
    serveFile();
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  return server;
}

function start() {
  const host=process.env.FRONTEND_HOST||'127.0.0.1',port=Number(process.env.FRONTEND_PORT||4175);
  const server=createFrontendServer();
  server.listen(port,host,()=>console.log(`Frontend: http://${host}:${port}`));
  server.on('error',error=>{console.error('Frontend could not start:',error.code||error.message);process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>process.exit(0)));
  return server;
}
if (require.main===module) start();
module.exports={createFrontendServer,start};
