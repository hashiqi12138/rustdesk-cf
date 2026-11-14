// TCP 代理：21119 → 21118（v2 带溯源与首帧抓取）
// ---------------------------------------------------------------------------
// 作用：
//   1. 把 21119 的流量导到 21118，路径重写为 /ws/relay，
//      让信令（21118 直连）和中继（21119）落在同一个 DO 上。
//   2. 注入 X-Real-Source: <真实 ip:port> 头 —— DO 侧日志就能区分
//      这条腿来自 192.168.2.2（本机）还是 192.168.2.182（对端）。
//   3. 打印每条连接的来源与第一个数据帧的 hex —— 用于诊断
//      「被控端到底有没有连中继、首包发的是什么」。
//
// 用法：
//   node rdserver/relay-proxy.mjs --listen 21119 --target 21118

import net from 'node:net';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const LISTEN = Number(args.listen || 21119);
const TARGET = Number(args.target || 21118);
const HOST = args.host || '127.0.0.1';
const REWRITE_PATH = args.path || '/ws/relay';

const ts = () => new Date().toISOString();

const server = net.createServer((client) => {
  const src = `${client.remoteAddress}:${client.remotePort}`;
  console.log(`${ts()} [proxy] conn from ${src}`);

  const up = net.connect(TARGET, HOST);
  client.setNoDelay(true);
  up.setNoDelay(true);

  let rewritten = false;
  let loggedClientFrame = false;
  let loggedUpstream = false;
  let headBuf = Buffer.alloc(0);

  client.on('data', (chunk) => {
    if (rewritten) {
      if (!loggedClientFrame && chunk.length) {
        loggedClientFrame = true;
        console.log(
          `${ts()} [proxy] ${src} first-frame (${chunk.length}B): ${chunk.subarray(0, 48).toString('hex')}`
        );
      }
      up.write(chunk);
      return;
    }
    headBuf = Buffer.concat([headBuf, chunk]);
    const idx = headBuf.indexOf('\r\n\r\n');
    if (idx < 0) {
      if (headBuf.length > 64 * 1024) { client.destroy(); up.destroy(); }
      return;
    }
    const head = headBuf.subarray(0, idx).toString('latin1');
    const rest = headBuf.subarray(idx + 4);

    const lines = head.split('\r\n');
    if (lines.length && /^GET\s+/i.test(lines[0])) {
      const parts = lines[0].split(' ');
      const curPath = parts[1] || '/';
      if (curPath === '/' || curPath === '') parts[1] = REWRITE_PATH;
      lines[0] = parts.join(' ');
    }
    lines.push(`X-Real-Source: ${src}`);
    console.log(`${ts()} [proxy] ${src} ${lines[0]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    if (rest.length) {
      console.log(`... first-frame with head: ${rest.subarray(0, 48).toString('hex')}`);
      up.write(rest);
    }
    rewritten = true;
  });

  up.on('data', (d) => {
    if (!loggedUpstream && d.length) {
      loggedUpstream = true;
      const end = d.indexOf('\r\n');
      const first = end >= 0 ? d.subarray(0, end) : d.subarray(0, 40);
      console.log(`${ts()} [proxy] ${src} <- ${first.toString('latin1').slice(0, 40)}`);
    }
    client.write(d);
  });

  const cleanup = () => {
    try { client.destroy(); } catch {}
    try { up.destroy(); } catch {}
  };
  client.on('error', () => { console.log(`${ts()} [proxy] ${src} client error`); cleanup(); });
  up.on('error', () => { console.log(`${ts()} [proxy] ${src} upstream error`); cleanup(); });
  client.on('close', () => { console.log(`${ts()} [proxy] ${src} closed`); cleanup(); });
  up.on('close', () => cleanup());
});

server.on('error', (e) => {
  console.error('relay proxy error:', e.message);
  process.exit(1);
});

server.listen(LISTEN, '0.0.0.0', () => {
  console.log(`${ts()} relay proxy :${LISTEN} -> ${HOST}:${TARGET}${REWRITE_PATH}`);
});
