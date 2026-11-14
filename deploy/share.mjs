// 临时文件分发服务：让 .182 能直接 HTTP 拉取部署文件
// 用法: node deploy/share.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here);
const port = Number(process.argv[2] || 8899);

const MIME = {
  '.ps1': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.exe': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let name = decodeURIComponent((req.url || '/').split('?')[0]);
  if (name === '/' || name === '') {
    const files = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>deploy</h1><ul>' +
        files.map((f) => `<li><a href="/${encodeURIComponent(f)}">${f}</a></li>`).join('') +
        '</ul>'
    );
    return;
  }
  const target = path.resolve(root, name.replace(/^\/+/, ''));
  if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const st = fs.statSync(target);
  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `attachment; filename="${path.basename(target)}"`,
  });
  fs.createReadStream(target).pipe(res);
  console.log(new Date().toISOString(), name, st.size);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`share root: ${root}`);
  console.log(`listening:  http://192.168.2.2:${port}/`);
});
