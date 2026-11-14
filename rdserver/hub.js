/**
 * RustDesk 信令 + 中继 Durable Object（v3.5）
 * ---------------------------------------------------------------------------
 * 一个 DO 实例 = 一台「hbbs + hbbr」。用单一实例做全局协调，
 * 因为 RustDesk 的 peer 表是全局的（任意两台设备都要能互相发现）。
 *
 * ===== 关键实现约束（都是踩过的坑，别改回去）=====
 *
 * 1. WebSocket 不能作为 RPC 参数跨 Worker→DO 传递，会触发
 *    "runtime canceled this request because your code had hung"。
 *    → 必须由 DO 自己 new WebSocketPair() 并返回 101 响应。
 *
 * 2. DO 里不要检查 Upgrade 头 —— 经 stub.fetch 转发后可能被剥离。
 *
 * 3. 返回 101 后，在 fetch() 里 addEventListener 注册的监听器会随请求结束
 *    被回收，消息永远收不到。必须用 Hibernatable WebSocket：
 *    state.acceptWebSocket() + webSocketMessage() 回调。
 *
 * 4. DO 随时可能被驱逐，**内存状态会丢**。peer 表必须落 storage；
 *    WebSocket 的身份信息必须用 serializeAttachment() 存进连接本身。
 *    驱逐恢复后中继配对关系（peer 指针不可序列化）也会丢 ——
 *    v3 修复：构造器里对恢复的 relay 腿按 attachment 里的 uuid 重新配对。
 *
 * 5. **在线判定必须看「活跃连接」而不是 lastReg 时间戳**。
 *    WS 模式下客户端确认 key 之后不再发 RegisterPeer（hbbs 原版靠 UDP
 *    常驻重注册，我们没有），30s 后 lastReg 过期就会误判「对方离线」，
 *    表现为 PunchHoleRequest 永远拿到 PH_OFFLINE ——
 *    这正是实测中 "Remote desktop is offline" 的根因。
 *
 * 6. 中继腿的首包必须是 RequestRelay（与 hbbr 的 make_pair_ 一致）。
 *    其它首包一律拒绝并记录（早期曾用「推断 uuid」兜底，会把无关腿
 *    错误配到一起，污染配对队列 —— 已移除）。
 *
 * ===== v3.5：ACK 回显路由 + 中继腿裸缓冲 =====
 *
 * 7. 主控在信令腿上同步等 RelayResponse ACK（1.5.3 client.rs request_relay：
 *    每次尝试新 socket + 新 uuid，共 3 次 × ~18s，收到 refuse_reason 为空的
 *    RelayResponse 即成功 —— 不校验 uuid）。hbbs 权威做法（rendezvous_server.rs
 *    L582-628）：转发 RequestRelay 时注入 socket_addr = AddrMangle::encode(主控地址)
 *    （L596）；被控端 RelayResponse 原样回显该字段（mediator create_relay L723/L775，
 *    initiate=false 时 uuid/relay_server/id 全空）；hbbs 解码后经 tcp_punch sink
 *    把 ACK 送回主控（L611-628）。v3 既没注入也没转发 ACK → 主控永远等不到 →
 *    「无法直接连接到远程桌面」。v3.5 按字节 hex 匹配路由（不做 decode ——
 *    AddrMangle 端口编码不自洽，字节匹配免疫）。
 *
 * 8. 中继腿只有 opener（RequestRelay{uuid}）是协议帧，其后全是裸会话字节
 *    （hbbr 语义：MAX_RELAY_REQUEST_LEN 只约束开腿首帧）。实测被控端 opener 后
 *    立刻发 PunchHole 44B + 2B `2a00`，比主控中继腿（要等 ACK 才拨）先到 ——
 *    v3 把它们当坏首包杀腿。v3.5：opener 后未配对的原样缓冲，配对成功
 *    先冲刷缓冲再裸转发。
 *
 * ===== 与原版 hbbs 的协议差异 =====
 *   - 不区分 UDP/TCP，注册和信令都在同一条 WS 上处理。
 *   - 不做 NAT 打洞，所有会话强制走中继（nat_type 一律 SYMMETRIC）。
 *   - socket_addr 用 AddrMangle 编码（端口字段在原算法里本就不自洽，
 *     客户端只用它做日志/去重，不影响中继）。
 */

import {
  parseMessage,
  parseRegisterPk,
  parseRegisterPeer,
  parsePunchHoleRequest,
  parseRequestRelay,
  parseRelayResponse,
  parseOnlineRequest,
  parseHealthCheck,
  registerPkResponse,
  registerPeerResponse,
  punchHoleResponse,
  testNatResponse,
  onlineResponse,
  addrMangle,
  bytesToHex,
  walk,
  tag,
  varint,
  UNION_FIELD,
  RK_OK,
  RK_INVALID_ID_FORMAT,
  PH_ID_NOT_EXIST,
  PH_OFFLINE,
  NAT_SYMMETRIC,
} from './protobuf.js';

const MAX_ID_LEN = 100;
const MIN_ID_LEN = 6;
// RustDesk 的 rendezvous 端口，用于 AddrMangle 里的端口字段
const RENDEZVOUS_PORT = 21116;
// 仅用于 debug 展示的过期阈值（在线判定改用活跃连接，见头部注释第 5 条）
const STALE_MS = 30_000;
// ACK 等待表过期：主控一轮 3 次尝试 × ~18s ≈ 54s，90s 覆盖两轮
const ACK_TTL_MS = 90_000;
// 中继腿配对前裸缓冲上限（对齐 hbbr MAX_RELAY_REQUEST_LEN 量级，防滥用）
const MAX_RELAY_BUF = 128 * 1024;

export class RdHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** 活跃连接：ws -> slot（含从 attachment 恢复的元数据） */
    this.slots = new Map();
    /** 中继等待队列：uuid -> [slot]（内存态；驱逐后由构造器重配对 + 客户端重连） */
    this.relayWaiters = new Map();
    /** ACK 等待表：mangled 主控地址 hex -> { ws, id, ts }（见头部注释第 7 条） */
    this.ackWaiters = new Map();
    /** peer 表缓存（storage 是真相，这里是热数据） */
    this.peerCache = new Map();

    // WS 模式心跳（mediator start_tcp L650-687）：客户端注册成功后完全静默，
    // 22.5s（keep_alive 15s × 1.5）收不到服务端消息就断线重连。hbbs 的做法
    // 写在客户端注释里（L662-666）：服务端定期推**空消息**，客户端原样回显。
    // DO alarm 每 10s 唤醒一次，向所有信令腿发 0 字节心跳；中继腿是裸流，
    // 任何注入都会破坏会话字节，绝不触碰。
    try { this.state.storage.setAlarm(Date.now() + 10_000); } catch {}

    // 恢复被驱逐前的连接，relay 腿按 uuid 重新进配对队列
    let restoredRelay = 0;
    for (const ws of this.state.getWebSockets()) {
      let meta = null;
      try { meta = ws.deserializeAttachment(); } catch {}
      if (!meta) continue;
      const slot = {
        kind: meta.kind || 'signal',
        ip: meta.ip || 'unknown',
        src: meta.src || null,
        id: meta.id || null,
        uuid: meta.uuid || null,
        peer: null,
        paired: false,
        ws,
      };
      this.slots.set(ws, slot);
      if (slot.kind === 'relay') {
        restoredRelay++;
        console.log(`[restore] relay leg src=${slot.src || slot.ip} uuid=${slot.uuid}`);
        if (slot.uuid) this.tryPair(ws, slot); // 两条腿都恢复后自动重新配对
      } else if (slot.id) {
        console.log(`[restore] signal leg id=${slot.id} src=${slot.src || slot.ip}`);
      }
    }
    if (restoredRelay) console.log(`[restore] ${restoredRelay} relay legs re-registered`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/debug') {
      return json(await this.debug());
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // relay-proxy 会注入 X-Real-Source（真实客户端 ip:port），
    // 直连（本机信令腿）时回退到 cf-connecting-ip
    const src = request.headers.get('x-real-source') || '';
    const ip = (src ? src.split(':')[0] : '') ||
      request.headers.get('cf-connecting-ip') || 'unknown';
    const kind = path.startsWith('/ws/relay') ? 'relay' : 'signal';

    this.state.acceptWebSocket(server);

    const slot = { kind, ip, src, id: null, uuid: null, peer: null, paired: false, ws: server };
    this.slots.set(server, slot);
    try { server.serializeAttachment({ kind, ip, src }); } catch {}

    console.log(`[${kind}] leg from ${src || ip}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ==================== 运行时回调 ====================

  async webSocketMessage(ws, message) {
    let slot = this.slots.get(ws);
    if (!slot) {
      // 驱逐恢复后可能没在 slots 里，用 attachment 重建
      let meta = null;
      try { meta = ws.deserializeAttachment(); } catch {}
      slot = {
        kind: meta?.kind || 'signal',
        ip: meta?.ip || 'unknown',
        src: meta?.src || null,
        id: meta?.id || null,
        uuid: meta?.uuid || null,
        peer: null,
        paired: false,
        ws,
      };
      this.slots.set(ws, slot);
    }

    const data = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : new Uint8Array(message);

    try {
      if (slot.kind === 'relay') {
        this.onRelayMessage(ws, slot, data);
      } else {
        await this.onSignalingMessage(ws, slot, data);
      }
    } catch (e) {
      console.error('handler error:', e && e.message, e && e.stack);
    }
  }

  /**
   * DO alarm 回调：每 10s 推 0 字节心跳到所有信令腿。
   * 客户端（mediator L662-666）收到空消息会原样回显并 continue——
   * 双向任何字节都会刷新 last_recv_msg，链路不再 22.5s 超时。
   * 中继腿是裸字节流，绝不注入（心跳只发 signal kind）。
   */
  async alarm() {
    let sent = 0;
    for (const [, slot] of this.slots) {
      if (slot.kind !== 'signal') continue;
      try { slot.ws.send(new Uint8Array(0)); sent++; } catch {}
    }
    try { this.state.storage.setAlarm(Date.now() + 10_000); } catch {}
  }

  async webSocketClose(ws) { await this.dropSlot(ws); }
  async webSocketError(ws) { await this.dropSlot(ws); }

  async dropSlot(ws) {
    const slot = this.slots.get(ws);
    if (!slot) return;
    this.slots.delete(ws);

    // 控端信令腿断开 → 它名下的 ACK 等待表项全部作废
    for (const [k, e] of this.ackWaiters) {
      if (e.ws === ws) this.ackWaiters.delete(k);
    }

    if (slot.kind === 'relay') {
      this.dropRelay(slot);
      return;
    }

    // 信令腿断开 → peer 标记离线（在线判定已经不依赖它，仅同步存储态）
    if (slot.id) {
      const peer = await this.getPeer(slot.id);
      if (peer) {
        peer.online = false;
        await this.putPeer(peer);
      }
    }
  }

  // ==================== peer 存储 ====================

  async getPeer(id) {
    if (this.peerCache.has(id)) return this.peerCache.get(id);
    const v = await this.state.storage.get('peer:' + id);
    if (v) this.peerCache.set(id, v);
    return v || null;
  }

  async putPeer(peer) {
    this.peerCache.set(peer.id, peer);
    await this.state.storage.put('peer:' + peer.id, peer);
  }

  // ==================== 信令 ====================

  async onSignalingMessage(ws, slot, data) {
    const { unionName, inner } = parseMessage(data);
    const who = slot.id || slot.src || slot.ip;
    if (!unionName || !inner) {
      const head = bytesToHex(data.subarray(0, Math.min(20, data.length)));
      console.log(`[sig] ${who} unknown len=${data.length} head=${head}`);
      return;
    }
    // 高频心跳不打日志
    if (unionName !== 'RegisterPeer' && unionName !== 'TestNatRequest') {
      console.log(`[sig] ${who} <- ${unionName} (${data.length}B)`);
    }

    switch (unionName) {
      case 'RegisterPk': return this.onRegisterPk(ws, slot, inner);
      case 'RegisterPeer': return this.onRegisterPeer(ws, slot, inner);
      case 'PunchHoleRequest': return this.onPunchHoleRequest(ws, slot, inner);
      case 'PunchHoleSent': return this.onPunchHoleSent(ws, inner);
      case 'RequestRelay': return this.onRequestRelay(ws, slot, inner);
      case 'RelayResponse': return this.onRelayResponse(ws, slot, data, inner);
      case 'TestNatRequest': return send(ws, testNatResponse(0));
      case 'OnlineRequest': return this.onOnlineRequest(ws, inner);
      case 'HealthCheck': return this.onHealthCheck(ws, inner);
      default:
        console.log(`[sig] ${who} <- ${unionName} (unhandled)`);
        return;
    }
  }

  async onRegisterPk(ws, slot, inner) {
    const { id, uuid, pk } = parseRegisterPk(inner);

    if (!id || id.length < MIN_ID_LEN || id.length > MAX_ID_LEN) {
      return send(ws, registerPkResponse(RK_INVALID_ID_FORMAT));
    }

    const peer = (await this.getPeer(id)) || {
      id, uuid: '', pkHex: '', ip: '', online: false, lastReg: 0,
    };
    peer.uuid = bytesToHex(uuid);
    peer.pkHex = bytesToHex(pk);
    peer.ip = slot.ip;
    peer.online = true;
    peer.lastReg = Date.now();
    await this.putPeer(peer);

    slot.id = id;
    try { ws.serializeAttachment({ kind: 'signal', ip: slot.ip, src: slot.src, id }); } catch {}

    send(ws, registerPkResponse(RK_OK, 15));
  }

  async onRegisterPeer(ws, slot, inner) {
    const { id } = parseRegisterPeer(inner);
    if (!id) return;

    const peer = (await this.getPeer(id)) || {
      id, uuid: '', pkHex: '', ip: '', online: false, lastReg: 0,
    };
    peer.ip = slot.ip;
    peer.online = true;
    peer.lastReg = Date.now();
    await this.putPeer(peer);

    slot.id = id;
    try { ws.serializeAttachment({ kind: 'signal', ip: slot.ip, src: slot.src, id }); } catch {}

    const requestPk = !peer.pkHex;
    send(ws, registerPeerResponse(requestPk));
  }

  async onPunchHoleRequest(ws, slot, inner) {
    const req = parsePunchHoleRequest(inner);
    const who = slot.id || slot.src || slot.ip;
    console.log(`[punch] ${who} -> ${req.id}`);

    const targetWs = req.id ? this.findWsById(req.id) : null;

    if (!targetWs) {
      const target = req.id ? await this.getPeer(req.id) : null;
      if (!target) {
        console.log(`[punch] ${req.id} not registered -> ID_NOT_EXIST`);
        return send(ws, punchHoleResponse({ failure: PH_ID_NOT_EXIST }));
      }
      console.log(`[punch] ${req.id} no live signal leg -> OFFLINE`);
      return send(ws, punchHoleResponse({ failure: PH_OFFLINE }));
    }

    // 在线判定 = 存在活跃信令腿（见头部注释第 5 条，不能用 lastReg 过期）
    const socketAddr = encodeAddrKey(slot.ip);
    const relay = this.env.RELAY_SERVER || '';

    // 只回控端「走中继」。不给被控端发 PunchHole ——
    // 被控端收到 PunchHole 会走 create_relay(initiate=true) 自造新 uuid，
    // 与控端在 RequestRelay 里带的 uuid 对不上，永远配不成对。
    // 正确路径：控端收到本响应后发 RequestRelay{uuid_A}，
    // 我们原样转发给被控端，被控端沿用 uuid_A 去中继挂腿。
    send(ws, punchHoleResponse({ socketAddr, relayServer: relay, natType: NAT_SYMMETRIC }));
    console.log(`[punch] ${req.id} online -> PunchHoleResponse(relay=${relay}) to ${who}`);
  }

  async onPunchHoleSent(ws, inner) {
    // PunchHoleSent{ socket_addr=1, id=2, relay_server=3, nat_type=4, version=5 }
    const id = readStr(inner, 2);
    const relayServer = readStr(inner, 3);
    const targetWs = id ? this.findWsById(id) : null;
    if (targetWs) {
      send(targetWs, punchHoleResponse({
        relayServer: relayServer || this.env.RELAY_SERVER || '',
        natType: NAT_SYMMETRIC,
      }));
    }
  }

  async onRequestRelay(ws, slot, inner) {
    const req = parseRequestRelay(inner);
    const targetWs = req.id ? this.findWsById(req.id) : null;
    console.log(
      `[RequestRelay] to=${req.id} uuid=${req.uuid} relay=${req.relayServer} targetWs=${!!targetWs}`
    );

    if (!targetWs) {
      console.log(`[RequestRelay] target ${req.id} no live leg`);
      return;
    }

    // hbbs 权威语义（rendezvous_server.rs L582-628）：转发 RequestRelay 时注入
    // socket_addr = AddrMangle::encode(主控地址)（L596）。被控端的 RelayResponse
    // 会原样回显该字段（mediator create_relay L723/L775，initiate=false 时
    // uuid/id/relay_server 全空）—— 这就是 ACK 的回程路由凭据，v3 缺这步。
    // 逐字节保留 inner 全部原始字段（token/switch_code/control_permissions 等），
    // 只在尾部追加 field 3，避免重建丢字段。
    const mangled = encodeAddrKey(slot.ip);
    const addrField = new Uint8Array([...tag(3, 2), ...varint(mangled.length), ...mangled]);
    const merged = new Uint8Array(inner.length + addrField.length);
    merged.set(inner, 0);
    merged.set(addrField, inner.length);

    send(targetWs, wrapUnion('RequestRelay', merged));

    const key = bytesToHex(mangled);
    this.ackWaiters.set(key, { ws, id: slot.id || null, ts: Date.now() });
    this.pruneAckWaiters();
    console.log(
      `[RequestRelay] forwarded to ${req.id} (verbatim + socket_addr, ack waiter=${key.slice(0, 16)}…)`
    );
  }

  async onRelayResponse(ws, _slot, data, inner) {
    const rr = parseRelayResponse(inner);
    // 被控端的 ACK（initiate=false）：uuid/id/relay_server 全空，凭回显的
    // socket_addr 字节匹配找回控端信令腿，整条消息原样回显给控端。
    // 控端 client.rs L1843-1848 只要求 refuse_reason 为空即成功，
    // 不读 uuid 也不读 socket_addr —— 无需构造/清洗，逐字回显即可。
    const key = bytesToHex(rr.socketAddr || new Uint8Array(0));
    const entry = key && this.ackWaiters.get(key);
    if (entry) {
      this.ackWaiters.delete(key);
      send(entry.ws, data);
      console.log(
        `[RelayResponse] ACK routed to controller ${entry.id || ''} (${data.length}B, ver=${rr.version || '?'})`
      );
    } else {
      console.log(
        `[RelayResponse] no ack waiter (id=${rr.id || '(empty)'} ver=${rr.version || '(empty)'})`
      );
    }
  }

  pruneAckWaiters() {
    const now = Date.now();
    for (const [k, e] of this.ackWaiters) {
      if (now - e.ts > ACK_TTL_MS) this.ackWaiters.delete(k);
    }
  }

  async onOnlineRequest(ws, inner) {
    const { peers } = parseOnlineRequest(inner);
    const states = new Uint8Array(peers.length);
    for (let i = 0; i < peers.length; i++) {
      states[i] = this.findWsById(peers[i]) ? 1 : 0;
    }
    send(ws, onlineResponse(states));
  }

  async onHealthCheck(ws, inner) {
    const { token } = parseHealthCheck(inner);
    if (token && token === this.env.HEALTH_TOKEN) {
      send(ws, wrapUnion('HealthCheck', []));
    }
  }

  /** 按注册 ID 找活跃信令腿 */
  findWsById(id) {
    for (const [, s] of this.slots) {
      if (s.kind === 'signal' && s.id === id) return s.ws;
    }
    return null;
  }

  // ==================== 中继 ====================

  onRelayMessage(ws, slot, data) {
    const src = slot.src || slot.ip;

    // 已配对：纯裸转发（hbbr 配对后不解析任何字节）
    if (slot.paired) {
      const peerSlot = slot.peer;
      if (!peerSlot || !peerSlot.ws) return;
      try {
        peerSlot.ws.send(data);
      } catch {
        this.dropRelay(slot);
      }
      return;
    }

    // 还没收到 opener：首帧必须是 RequestRelay{uuid}（hbbr make_pair_ 同款）
    if (!slot.uuid) {
      const { unionName, inner } = parseMessage(data);
      const head = bytesToHex(data.subarray(0, Math.min(32, data.length)));
      if (unionName === 'RequestRelay' && inner) {
        const rr = parseRequestRelay(inner);
        if (rr.uuid) {
          slot.uuid = rr.uuid;
          try {
            ws.serializeAttachment({ kind: 'relay', ip: slot.ip, src: slot.src, uuid: rr.uuid });
          } catch {}
          console.log(`[relay] ${src} RequestRelay uuid=${rr.uuid}`);
          this.tryPair(ws, slot);
          return;
        }
      }

      console.log(
        `[relay] DROP first msg from ${src}: union=${unionName} len=${data.length} head=${head}`
      );
      try { ws.close(1000, 'first message must be RequestRelay'); } catch {}
      this.slots.delete(ws);
      return;
    }

    // opener 已收、对腿未配成（主控要等 ACK 才拨中继腿，被控端的会话字节
    // 总是先到）：原样缓冲，配对成功后冲刷 —— v3 在这里错误地解析并杀腿，
    // 这正是「PunchHole 44B + 2a00 被丢」的根因。
    if (!slot.buf) slot.buf = [];
    let buffered = 0;
    for (const c of slot.buf) buffered += c.length;
    if (buffered + data.length > MAX_RELAY_BUF) {
      console.log(`[relay] buffer overflow from ${src} (${buffered + data.length}B), closing leg`);
      try { ws.close(1000, 'buffer overflow'); } catch {}
      this.dropRelay(slot);
      return;
    }
    slot.buf.push(data.slice());
    console.log(
      `[relay] buffered ${data.length}B from ${src} (waiting pair, total ${buffered + data.length}B)`
    );
  }

  tryPair(ws, slot) {
    slot.ws = ws;
    const key = slot.uuid;
    if (!key) return;

    let list = this.relayWaiters.get(key);
    if (!list) {
      list = [];
      this.relayWaiters.set(key, list);
    }

    const idx = list.findIndex((s) => s !== slot && !s.paired);
    if (idx >= 0) {
      const other = list[idx];
      list.splice(idx, 1);
      if (list.length === 0) this.relayWaiters.delete(key);

      slot.peer = other;
      other.peer = slot;
      slot.paired = true;
      other.paired = true;
      console.log(
        `[relay] *** PAIRED uuid=${key}  ${slot.src || slot.ip} <-> ${other.src || other.ip} ***`
      );
      // 配对成立：先冲刷两条腿配对前缓冲的裸会话字节（被控端先到时攒下的
      // PunchHole/密钥交换等帧），再进入纯裸转发。
      this.flushBuf(slot, other);
      this.flushBuf(other, slot);
      return;
    }

    list.push(slot);
    console.log(`[relay] waiting uuid=${key} (${list.length} in queue)`);
  }

  /** 冲刷一条腿配对前缓冲的裸字节到对腿 */
  flushBuf(from, to) {
    if (!from.buf || !from.buf.length) return;
    let n = 0;
    for (const chunk of from.buf) {
      n += chunk.length;
      try { to.ws.send(chunk); } catch { this.dropRelay(from); return; }
    }
    console.log(`[relay] flushed ${n}B pre-pair bytes ${from.src || from.ip} -> ${to.src || to.ip}`);
    from.buf = null;
  }

  dropRelay(slot) {
    slot.buf = null;
    if (slot.peer) {
      const other = slot.peer;
      slot.peer = null;
      slot.paired = false;
      other.peer = null;
      other.paired = false;
      console.log(`[relay] pair broken uuid=${slot.uuid} (${other.src || other.ip} leg closed)`);
      try { other.ws.close(1000, 'peer gone'); } catch {}
    }
    const key = slot.uuid;
    if (!key) return;
    const list = this.relayWaiters.get(key);
    if (list) {
      const i = list.indexOf(slot);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.relayWaiters.delete(key);
    }
  }

  // ==================== 工具 ====================

  async debug() {
    const stored = await this.state.storage.list({ prefix: 'peer:' });
    const peers = [];
    for (const [, v] of stored) {
      peers.push({
        id: v.id,
        ip: v.ip,
        live: !!this.findWsById(v.id),
        online: v.online,
        ageMs: v.lastReg ? Date.now() - v.lastReg : null,
      });
    }
    let pairs = 0;
    const slots = [...this.slots.values()].map((s) => {
      if (s.kind === 'relay' && s.paired) pairs++;
      return {
        kind: s.kind,
        src: s.src || s.ip,
        id: s.id,
        uuid: s.uuid,
        paired: s.paired,
      };
    });
    return {
      peers,
      slots,
      relayPairs: pairs / 2,
      relayWaiters: [...this.relayWaiters.entries()].map(([k, v]) => [k, v.length]),
      ackWaiters: this.ackWaiters.size,
    };
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function send(ws, bytes) {
  if (!ws || !bytes) return;
  try { ws.send(bytes); } catch {}
}

/**
 * 生产兜底：CF 边缘的 cf-connecting-ip 通常是 IPv6，addrMangle 只认 IPv4，
 * 非 IPv4 会返回空数组 → 注入的 socket_addr 为空 → ACK 路由键变空串断链。
 * 这里把非 IPv4 输入折叠成确定性合成 IPv4（FNV-1a），保证注入字节非空
 * 且每个客户端唯一。ACK 路由只做 hex 字节匹配、从不 decode，合成值
 * 不影响正确性；被控端日志 decode 出的也是无害的合成地址。
 */
function encodeAddrKey(ip) {
  const m = addrMangle(ip, RENDEZVOUS_PORT);
  if (m.length) return m;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < ip.length; i++) {
    h = ((h ^ ip.charCodeAt(i)) * 16777619) >>> 0;
  }
  const syn = ((h >>> 24) & 255) + '.' + ((h >>> 16) & 255) + '.' + ((h >>> 8) & 255) + '.' + (h & 255);
  return addrMangle(syn, RENDEZVOUS_PORT);
}

function readStr(inner, field) {
  let out = '';
  try {
    walk(inner, (f, w, _v, raw) => {
      if (f === field && w === 2 && raw) out = new TextDecoder().decode(raw);
    });
  } catch {}
  return out;
}

function wrapUnion(name, inner) {
  const field = UNION_FIELD[name];
  if (!field) return null;
  const head = [...tag(field, 2), ...varint(inner.length)];
  const out = new Uint8Array(head.length + inner.length);
  out.set(head, 0);
  out.set(inner, head.length);
  return out;
}
