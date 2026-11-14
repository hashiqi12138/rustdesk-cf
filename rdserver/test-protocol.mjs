// 协议级测试：验证自研 DO 服务端的注册、打洞、中继配对
// 用法: node rdserver/test-protocol.mjs [wsBase]

const base = process.argv[2] || 'ws://127.0.0.1:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- protobuf ----------
function varint(n) { const o = []; let v = n >>> 0; while (v > 127) { o.push((v & 0x7f) | 0x80); v >>>= 7; } o.push(v); return o; }
const tag = (f, w) => varint((f << 3) | w);
const strF = (f, s) => { const b = [...new TextEncoder().encode(s)]; return [...tag(f, 2), ...varint(b.length), ...b]; };
const i32F = (f, v) => [...tag(f, 0), ...varint(v)];
const bytesF = (f, b) => { const a = [...b]; return [...tag(f, 2), ...varint(a.length), ...a]; };
const msgF = (f, i) => bytesF(f, i);

function rv(buf, i) { let s = 0, v = 0; for (;;) { const b = buf[i++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; } return [v >>> 0, i]; }
function walk(buf, cb) {
  let i = 0;
  while (i < buf.length) {
    let k; [k, i] = rv(buf, i);
    const f = k >>> 3, w = k & 7;
    if (w === 0) { let v; [v, i] = rv(buf, i); cb(f, w, v, null); }
    else if (w === 2) { let l; [l, i] = rv(buf, i); cb(f, w, null, buf.subarray(i, i + l)); i += l; }
    else if (w === 5) { cb(f, w, null, buf.subarray(i, i + 4)); i += 4; }
    else if (w === 1) { cb(f, w, null, buf.subarray(i, i + 8)); i += 8; }
    else break;
  }
}
const U = { 6: 'RegisterPeer', 7: 'RegisterPeerResponse', 8: 'PunchHoleRequest', 9: 'PunchHole', 10: 'PunchHoleSent', 11: 'PunchHoleResponse', 13: 'LocalAddr', 15: 'RegisterPk', 16: 'RegisterPkResponse', 18: 'RequestRelay', 19: 'RelayResponse', 20: 'TestNatRequest', 21: 'TestNatResponse', 23: 'OnlineRequest', 24: 'OnlineResponse' };

function decode(u8) {
  const buf = Buffer.from(u8);
  let name = null, inner = null;
  try { walk(buf, (f, w, _v, raw) => { if (!name && U[f] && raw) { name = U[f]; inner = raw; } }); } catch {}
  if (!name) return { raw: buf.toString('hex').slice(0, 40) };
  const fields = [];
  if (inner) {
    try { walk(inner, (f, w, v, raw) => {
      let val = v;
      if (val == null && raw) {
        const s = Buffer.from(raw).toString('utf8');
        val = /^[\x20-\x7e]{1,50}$/.test(s) ? s : `bytes(${raw.length})`;
      }
      fields.push({ f, v: val, raw: raw ? Buffer.from(raw).toString('hex') : null });
    }); } catch {}
  }
  return { union: name, fields };
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const msgs = [];
    ws.addEventListener('message', (e) => msgs.push(decode(new Uint8Array(e.data))));
    ws.addEventListener('open', () => resolve({ ws, msgs }));
    ws.addEventListener('error', () => reject(new Error('ws error: ' + url)));
    setTimeout(() => reject(new Error('open timeout: ' + url)), 8000);
  });
}

const results = {};

// ===== 1. RegisterPk =====
{
  const { ws, msgs } = await open(`${base}/ws/id`);
  await sleep(300);
  ws.send(new Uint8Array(msgF(15, [
    ...strF(1, '111222333'),
    ...bytesF(2, Buffer.from('11111111-2222-3333-4444-555555555555'.replace(/-/g, ''), 'hex')),
    ...bytesF(3, Buffer.alloc(32, 0x11)),
  ])).buffer);
  await sleep(1200);
  const rk = msgs.find((m) => m.union === 'RegisterPkResponse');
  results.registerPk = {
    got: rk || null,
    result: rk?.fields.find((x) => x.f === 1)?.v,
    pass: rk?.fields.find((x) => x.f === 1)?.v === 0,
  };
  try { ws.close(); } catch {}
}

// ===== 2. 全流程：注册 → 打洞 → RequestRelay 转发(注入 socket_addr) → ACK 回显 =====
{
  const A = await open(`${base}/ws/id`);
  await sleep(200);
  A.ws.send(new Uint8Array(msgF(15, [
    ...strF(1, 'aaaa11111'),
    ...bytesF(2, Buffer.alloc(16, 0xaa)),
    ...bytesF(3, Buffer.alloc(32, 0xaa)),
  ])).buffer);
  const B = await open(`${base}/ws/id`);
  await sleep(200);
  B.ws.send(new Uint8Array(msgF(15, [
    ...strF(1, 'bbbb22222'),
    ...bytesF(2, Buffer.alloc(16, 0xbb)),
    ...bytesF(3, Buffer.alloc(32, 0xbb)),
  ])).buffer);
  await sleep(600);

  // A（主控）打洞：hub 只回 PunchHoleResponse，不转发 PunchHole（v3.5 语义）
  A.ws.send(new Uint8Array(msgF(8, [
    ...strF(1, 'bbbb22222'),
    ...i32F(2, 0),
    ...strF(3, ''),
    ...i32F(4, 0),
    ...strF(5, ''),
    ...strF(6, '1.5.3'),
  ])).buffer);
  await sleep(800);
  const aResp = A.msgs.find((m) => m.union === 'PunchHoleResponse');

  // A 的重试腿（全新连接、不注册）发 RequestRelay —— 对齐 client.rs request_relay
  const U = '11111111-2222-3333-4444-555555555555';
  const A2 = await open(`${base}/ws/id`);
  await sleep(200);
  A2.ws.send(new Uint8Array(msgF(18, [
    ...strF(1, 'bbbb22222'),
    ...strF(2, U),
    ...strF(4, '192.168.2.2'),
    ...i32F(5, 1),
  ])).buffer);
  await sleep(800);

  // B 应收到转发：uuid 原样 + hub 注入的 socket_addr（field 3）
  const fwd = B.msgs.find((m) => m.union === 'RequestRelay');
  const fwdUuid = fwd?.fields.find((x) => x.f === 2)?.v;
  const fwdAddrHex = fwd?.fields.find((x) => x.f === 3)?.raw || null;

  // B 的 ACK 走全新短命连接（mediator create_relay：connect_tcp 后即发即弃）
  const C = await open(`${base}/ws/id`);
  await sleep(200);
  if (fwdAddrHex) {
    C.ws.send(new Uint8Array(msgF(19, [
      ...bytesF(1, Buffer.from(fwdAddrHex, 'hex')),
      ...strF(7, '1.5.3'),
    ])).buffer);
  }
  await sleep(800);

  // A2 应在重试腿上收到原样回显的 ACK，socket_addr 字节与注入的完全一致
  const ack = A2.msgs.find((m) => m.union === 'RelayResponse');
  const ackAddrHex = ack?.fields.find((x) => x.f === 1)?.raw || null;
  results.relayAckFlow = {
    punchResponse: !!aResp,
    forwardedUuid: fwdUuid,
    forwardedHasSocketAddr: !!fwdAddrHex,
    ackEchoedToRetryLeg: !!ack,
    ackAddrMatches: !!fwdAddrHex && fwdAddrHex === ackAddrHex,
    pass: !!aResp && fwdUuid === U && !!fwdAddrHex && fwdAddrHex === ackAddrHex,
  };
  try { A.ws.close(); B.ws.close(); A2.ws.close(); C.ws.close(); } catch {}
}

// ===== 3. 不存在的 ID =====
{
  const { ws, msgs } = await open(`${base}/ws/id`);
  await sleep(200);
  ws.send(new Uint8Array(msgF(15, [
    ...strF(1, 'cccc33333'),
    ...bytesF(2, Buffer.alloc(16, 0xcc)),
    ...bytesF(3, Buffer.alloc(32, 0xcc)),
  ])).buffer);
  await sleep(500);
  ws.send(new Uint8Array(msgF(8, [
    ...strF(1, 'zzzz99999'),
    ...i32F(2, 0), ...strF(3, ''), ...i32F(4, 0), ...strF(5, ''), ...strF(6, '1.5.3'),
  ])).buffer);
  await sleep(1000);
  const r = msgs.find((m) => m.union === 'PunchHoleResponse');
  results.punchHoleMissingId = {
    got: !!r,
    failure: r?.fields.find((x) => x.f === 3)?.v,
    pass: r?.fields.find((x) => x.f === 3)?.v === 0, // 0 = ID_NOT_EXIST
  };
  try { ws.close(); } catch {}
}

// ===== 4. 中继配对 =====
{
  const R1 = await open(`${base}/ws/relay`);
  await sleep(300);
  R1.ws.send(new Uint8Array(msgF(18, [
    ...strF(1, 'relay-test'),
    ...strF(2, 'pair-uuid-0001'),
    ...i32F(5, 1),
  ])).buffer);
  await sleep(800);

  const R2 = await open(`${base}/ws/relay`);
  await sleep(300);
  R2.ws.send(new Uint8Array(msgF(18, [
    ...strF(1, 'relay-test'),
    ...strF(2, 'pair-uuid-0001'),
    ...i32F(5, 1),
  ])).buffer);
  await sleep(1000);

  const P1 = 'PING-FROM-R1-' + Date.now();
  const P2 = 'PONG-FROM-R2-' + Date.now();
  R1.ws.send(new TextEncoder().encode(P1).buffer);
  await sleep(600);
  R2.ws.send(new TextEncoder().encode(P2).buffer);
  await sleep(800);

  const r1Text = R1.msgs.map((m) => m.raw ? '' : JSON.stringify(m)).join('');
  // 直接看原始字节更准，重连一次拿 raw
  results.relayPair = {
    r1MsgCount: R1.msgs.length,
    r2MsgCount: R2.msgs.length,
    note: '需要看原始字节确认，见下一项',
  };
  try { R1.ws.close(); R2.ws.close(); } catch {}
}

// ===== 5. 中继裸字节转发（精确验证）=====
{
  const R1 = await open(`${base}/ws/relay`);
  const R2 = await open(`${base}/ws/relay`);
  const raw1 = [];
  const raw2 = [];
  R1.ws.addEventListener('message', (e) => { if (typeof e.data !== 'string') raw1.push(Buffer.from(new Uint8Array(e.data))); });
  R2.ws.addEventListener('message', (e) => { if (typeof e.data !== 'string') raw2.push(Buffer.from(new Uint8Array(e.data))); });

  await sleep(300);
  R1.ws.send(new Uint8Array(msgF(18, [...strF(1, 'x'), ...strF(2, 'pair-uuid-0002'), ...i32F(5, 1)])).buffer);
  await sleep(700);
  R2.ws.send(new Uint8Array(msgF(18, [...strF(1, 'x'), ...strF(2, 'pair-uuid-0002'), ...i32F(5, 1)])).buffer);
  await sleep(900);

  const p1 = Buffer.from('HELLO-FROM-R1-' + Date.now());
  const p2 = Buffer.from('HELLO-FROM-R2-' + Date.now());
  R1.ws.send(p1);
  await sleep(600);
  R2.ws.send(p2);
  await sleep(900);

  const r2got = Buffer.concat(raw2).toString('utf8');
  const r1got = Buffer.concat(raw1).toString('utf8');

  results.relayRawForward = {
    r2Received: r2got.slice(0, 60),
    r1Received: r1got.slice(0, 60),
    r2GotP1: r2got.includes(p1.toString()),
    r1GotP2: r1got.includes(p2.toString()),
    pass: r2got.includes(p1.toString()) && r1got.includes(p2.toString()),
  };
  try { R1.ws.close(); R2.ws.close(); } catch {}
}

// ===== 6. 配对前缓冲冲刷（被控端先到场景，v3.5 核心行为）=====
{
  const R1 = await open(`${base}/ws/relay`);
  const R2 = await open(`${base}/ws/relay`);
  const raw1 = [];
  const raw2 = [];
  R1.ws.addEventListener('message', (e) => { if (typeof e.data !== 'string') raw1.push(Buffer.from(new Uint8Array(e.data))); });
  R2.ws.addEventListener('message', (e) => { if (typeof e.data !== 'string') raw2.push(Buffer.from(new Uint8Array(e.data))); });

  await sleep(300);
  // R1（受控端模拟）先发 opener，随后立刻发会话字节 —— 此时对腿还没到
  R1.ws.send(new Uint8Array(msgF(18, [...strF(1, 'x'), ...strF(2, 'pair-uuid-0003'), ...i32F(5, 1)])).buffer);
  await sleep(200);
  const EARLY = Buffer.from('EARLY-SESSION-BYTES-' + Date.now());
  R1.ws.send(EARLY);
  await sleep(500);

  // R1（此时已缓冲）在 R2 到来前不应该收到任何东西
  const r1Before = raw1.length;

  // R2（主控模拟，等 ACK 后才拨）到 → 配对 → 先冲刷 R1 缓冲再裸转发
  R2.ws.send(new Uint8Array(msgF(18, [...strF(1, 'x'), ...strF(2, 'pair-uuid-0003'), ...i32F(5, 1)])).buffer);
  await sleep(900);

  const LATE = Buffer.from('LATE-SESSION-BYTES-' + Date.now());
  R2.ws.send(LATE);
  await sleep(700);

  const r2got = Buffer.concat(raw2).toString('utf8');
  const r1got = Buffer.concat(raw1).toString('utf8');
  results.relayPrePairBuffer = {
    r1GotNothingBeforePair: r1Before === 0,
    r2ReceivedFlushedEarly: r2got.includes(EARLY.toString()),
    r1ReceivedLate: r1got.includes(LATE.toString()),
    pass: r1Before === 0 && r2got.includes(EARLY.toString()) && r1got.includes(LATE.toString()),
  };
  try { R1.ws.close(); R2.ws.close(); } catch {}
}

console.log(JSON.stringify(results, null, 2));

const allPass = Object.values(results).every((r) => r.pass !== false);
console.log('\n=== ' + (allPass ? '全部通过' : '有失败项') + ' ===');
process.exit(allPass ? 0 : 1);
