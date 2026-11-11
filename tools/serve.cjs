#!/usr/bin/env node
// Tiny zero-dependency static server for local development.
//   node tools/serve.cjs [port=8080] [root=.]
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const root = path.resolve(process.argv[3] || '.');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.glsl': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`; headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers); fs.createReadStream(file, { start, end }).pipe(res); return;
    }
    res.writeHead(200, headers); fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => console.log(`SONDER dev server: http://localhost:${port}/  (root ${root})`));
