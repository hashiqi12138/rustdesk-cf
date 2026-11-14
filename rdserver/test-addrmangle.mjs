// AddrMangle 编码/解码往返自测
// 用法: node rdserver/test-addrmangle.mjs

import { addrMangle, addrMangleDecode } from './protobuf.js';

const cases = [
  ['192.168.2.182', 21116],
  ['192.168.2.2', 21116],
  ['127.0.0.1', 21116],
  ['10.0.0.1', 65535],
];

let allOk = true;
for (const [ip, port] of cases) {
  const enc = addrMangle(ip, port);
  const dec = addrMangleDecode(enc);
  const ok = dec.ip === ip && dec.port === port;
  if (!ok) allOk = false;
  console.log(
    `${ip}:${port}  ->  hex=${Buffer.from(enc).toString('hex')} (${enc.length}B)  ->  ${dec.ip}:${dec.port}  ${ok ? 'OK' : 'FAIL'}`
  );
}

console.log(allOk ? '\n=== 全部通过 ===' : '\n=== 有失败项 ===');
process.exit(allOk ? 0 : 1);
