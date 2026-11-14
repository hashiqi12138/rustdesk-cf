/**
 * RustDesk 协议 protobuf 极简编解码（Workers 运行时，零依赖）
 * ---------------------------------------------------------------------------
 * 只实现本服务端需要读写的字段，不是完整 protobuf 库。
 * 字段号严格对齐 hbb_common/protos/rendezvous.proto。
 */

// ---- union 字段号 → 名称（RendezvousMessage 的 oneof）----
export const UNION = {
  6: 'RegisterPeer',
  7: 'RegisterPeerResponse',
  8: 'PunchHoleRequest',
  9: 'PunchHole',
  10: 'PunchHoleSent',
  11: 'PunchHoleResponse',
  12: 'FetchLocalAddr',
  13: 'LocalAddr',
  14: 'ConfigUpdate',
  15: 'RegisterPk',
  16: 'RegisterPkResponse',
  17: 'SoftwareUpdate',
  18: 'RequestRelay',
  19: 'RelayResponse',
  20: 'TestNatRequest',
  21: 'TestNatResponse',
  22: 'PeerDiscovery',
  23: 'OnlineRequest',
  24: 'OnlineResponse',
  25: 'KeyExchange',
  26: 'HealthCheck',
  27: 'HttpProxyRequest',
  28: 'HttpProxyResponse',
  29: 'IceCandidate',
};

export const UNION_FIELD = Object.fromEntries(
  Object.entries(UNION).map(([num, name]) => [name, Number(num)])
);

// RegisterPkResponse.Result
export const RK_OK = 0;
export const RK_UUID_MISMATCH = 2;
export const RK_ID_EXISTS = 3;
export const RK_TOO_FREQUENT = 4;
export const RK_INVALID_ID_FORMAT = 5;
export const RK_NOT_SUPPORT = 6;
export const RK_SERVER_ERROR = 7;
export const RK_NOT_DEPLOYED = 8;

// PunchHoleResponse.Failure
export const PH_ID_NOT_EXIST = 0;
export const PH_OFFLINE = 2;
export const PH_LICENSE_MISMATCH = 3;
export const PH_LICENSE_OVERUSE = 4;

// NatType
export const NAT_UNKNOWN = 0;
export const NAT_ASYMMETRIC = 1;
export const NAT_SYMMETRIC = 2;

// ---------------- 编码 ----------------
export function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

export const tag = (field, wire) => varint((field << 3) | wire);

export function strField(field, s) {
  const b = [...new TextEncoder().encode(s)];
  return [...tag(field, 2), ...varint(b.length), ...b];
}

export function bytesField(field, bytes) {
  const a = [...bytes];
  return [...tag(field, 2), ...varint(a.length), ...a];
}

export function intField(field, v) {
  return [...tag(field, 0), ...varint(v)];
}

export function msgField(field, inner) {
  return bytesField(field, inner);
}

/** 包一层 union：msgField(unionField, innerFields) */
export function wrap(unionName, innerFields) {
  return new Uint8Array(msgField(UNION_FIELD[unionName], innerFields));
}

// ---------------- 解码 ----------------
function readVarint(buf, i) {
  let shift = 0;
  let val = 0;
  for (;;) {
    if (i >= buf.length) throw new Error('eof');
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  return [val >>> 0, i];
}

/**
 * 遍历一层 protobuf 字段。
 * onField(field, wire, valueOrNull, bytesOrNull)
 */
export function walk(buf, onField) {
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      onField(field, wire, v, null);
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const raw = buf.subarray(i, i + len);
      i += len;
      onField(field, wire, null, raw);
    } else if (wire === 5) {
      onField(field, wire, null, buf.subarray(i, i + 4));
      i += 4;
    } else if (wire === 1) {
      onField(field, wire, null, buf.subarray(i, i + 8));
      i += 8;
    } else {
      break;
    }
  }
}

/** 返回 { unionName, inner: Uint8Array } */
export function parseMessage(buf) {
  let unionName = null;
  let inner = null;
  try {
    walk(buf, (field, wire, _v, raw) => {
      if (unionName) return;
      if (wire === 2 && UNION[field] && raw) {
        unionName = UNION[field];
        inner = raw;
      }
    });
  } catch {
    /* 半包或非 protobuf */
  }
  return { unionName, inner };
}

/** 从内层字段读字符串 */
export function readString(inner, field) {
  let out = '';
  try {
    walk(inner, (f, w, _v, raw) => {
      if (f === field && w === 2 && raw) out = new TextDecoder().decode(raw);
    });
  } catch {}
  return out;
}

/** 从内层字段读 bytes */
export function readBytes(inner, field) {
  let out = new Uint8Array(0);
  try {
    walk(inner, (f, w, _v, raw) => {
      if (f === field && w === 2 && raw) out = new Uint8Array(raw);
    });
  } catch {}
  return out;
}

/** 从内层字段读整数 */
export function readInt(inner, field) {
  let out = 0;
  try {
    walk(inner, (f, w, v) => {
      if (f === field && w === 0 && typeof v === 'number') out = v;
    });
  } catch {}
  return out;
}

// ---------------- 常用消息构造 ----------------

/** RegisterPkResponse{ result, keep_alive } */
export function registerPkResponse(result, keepAlive = 0) {
  const inner = [...intField(1, result)];
  if (keepAlive > 0) inner.push(...intField(2, keepAlive));
  return wrap('RegisterPkResponse', inner);
}

/** RegisterPeerResponse{ request_pk } */
export function registerPeerResponse(requestPk) {
  return wrap('RegisterPeerResponse', [...intField(2, requestPk ? 1 : 0)]);
}

/**
 * PunchHole{ socket_addr, relay_server, nat_type, ... }
 * 全部走中继时 nat_type 设 SYMMETRIC，客户端据此强制 relay。
 */
export function punchHole({ socketAddr, relayServer, natType = NAT_SYMMETRIC }) {
  const inner = [];
  if (socketAddr && socketAddr.length) inner.push(...bytesField(1, socketAddr));
  if (relayServer) inner.push(...strField(2, relayServer));
  inner.push(...intField(3, natType));
  return wrap('PunchHole', inner);
}

/**
 * FetchLocalAddr{ socket_addr=1, relay_server=2, socket_addr_v6=3 }
 *
 * 为什么用它而不是 PunchHole：
 *   客户端 handle_intranet() 会调用 remember_reported_relay(relay_server)，
 *   把中继地址记进 REPORTED_RELAYS。后续 RequestRelay 到达时，
 *   check_relay_request() 要求 relay_server 必须「被本端报告过」，
 *   否则静默丢弃（bail "relay server was not offered by this peer"）。
 *   用 PunchHole 不会触发这个登记，导致中继请求永远被拒。
 */
export function fetchLocalAddr({ socketAddr, relayServer }) {
  const inner = [];
  if (socketAddr && socketAddr.length) inner.push(...bytesField(1, socketAddr));
  if (relayServer) inner.push(...strField(2, relayServer));
  return wrap('FetchLocalAddr', inner);
}

/**
 * PunchHoleResponse{ socket_addr, pk, failure, relay_server, nat_type }
 * 注意：failure 是 oneof 之外单独字段，正常成功时不设 failure。
 */
export function punchHoleResponse({
  socketAddr,
  pk,
  failure,
  relayServer,
  natType,
  id,
}) {
  const inner = [];
  if (socketAddr && socketAddr.length) inner.push(...bytesField(1, socketAddr));
  if (pk && pk.length) inner.push(...bytesField(2, pk));
  if (failure !== undefined && failure !== null) inner.push(...intField(3, failure));
  if (relayServer) inner.push(...strField(4, relayServer));
  if (natType !== undefined && natType !== null) inner.push(...intField(5, natType));
  if (id) inner.push(...strField(7, id));
  return wrap('PunchHoleResponse', inner);
}

/** RelayResponse{ socket_addr, uuid, relay_server, id, version } */
export function relayResponse({ socketAddr, uuid, relayServer, id, version }) {
  const inner = [];
  if (socketAddr && socketAddr.length) inner.push(...bytesField(1, socketAddr));
  if (uuid) inner.push(...strField(2, uuid));
  if (relayServer) inner.push(...strField(3, relayServer));
  if (id) inner.push(...strField(4, id));
  if (version) inner.push(...strField(7, version));
  return wrap('RelayResponse', inner);
}

/** TestNatResponse{ port } */
export function testNatResponse(port) {
  return wrap('TestNatResponse', [...intField(1, port)]);
}

/** ConfigUpdate{ serial, rendezvous_servers[] } */
export function configUpdate(serial, servers) {
  const inner = [...intField(1, serial)];
  for (const s of servers) inner.push(...strField(2, s));
  return wrap('ConfigUpdate', inner);
}

/** 解 RegisterPk{ id=1, uuid=2, pk=3 } */
export function parseRegisterPk(inner) {
  return {
    id: readString(inner, 1),
    uuid: readBytes(inner, 2),
    pk: readBytes(inner, 3),
  };
}

/** 解 RegisterPeer{ id=1, serial=2 } */
export function parseRegisterPeer(inner) {
  return { id: readString(inner, 1), serial: readInt(inner, 2) };
}

/** 解 PunchHoleRequest{ id=1, nat_type=2, licence_key=3, conn_type=4, token=5, version=6, force_relay=8 } */
export function parsePunchHoleRequest(inner) {
  return {
    id: readString(inner, 1),
    natType: readInt(inner, 2),
    licenceKey: readString(inner, 3),
    connType: readInt(inner, 4),
    token: readString(inner, 5),
    version: readString(inner, 6),
    forceRelay: readInt(inner, 8),
  };
}

/** 解 RequestRelay{ id=1, uuid=2, socket_addr=3, relay_server=4, secure=5, licence_key=6, conn_type=7 } */
export function parseRequestRelay(inner) {
  return {
    id: readString(inner, 1),
    uuid: readString(inner, 2),
    socketAddr: readBytes(inner, 3),
    relayServer: readString(inner, 4),
    secure: readInt(inner, 5),
    licenceKey: readString(inner, 6),
    connType: readInt(inner, 7),
  };
}

/**
 * 重新编码 RequestRelay，可覆盖 uuid。
 * 用于：把控端的 uuid 强写给被控端，保证两端用同一个配对键。
 * hbbr 的配对键就是 uuid —— 两端 uuid 不同永远配不上。
 */
export function buildRequestRelay({
  id,
  uuid,
  socketAddr,
  relayServer,
  secure,
  licenceKey,
  connType,
}) {
  const inner = [];
  if (id) inner.push(...strField(1, id));
  if (uuid) inner.push(...strField(2, uuid));
  if (socketAddr && socketAddr.length) inner.push(...bytesField(3, socketAddr));
  if (relayServer) inner.push(...strField(4, relayServer));
  if (secure !== undefined) inner.push(...intField(5, secure));
  if (licenceKey) inner.push(...strField(6, licenceKey));
  if (connType !== undefined) inner.push(...intField(7, connType));
  return wrap('RequestRelay', inner);
}

/** 解 RelayResponse */
export function parseRelayResponse(inner) {
  return {
    socketAddr: readBytes(inner, 1),
    uuid: readString(inner, 2),
    relayServer: readString(inner, 3),
    id: readString(inner, 4),
    pk: readBytes(inner, 5),
    version: readString(inner, 7),
  };
}

/** 解 OnlineRequest{ id=1, peers=2[] } */
export function parseOnlineRequest(inner) {
  const id = readString(inner, 1);
  const peers = [];
  try {
    walk(inner, (f, w, _v, raw) => {
      if (f === 2 && w === 2 && raw) peers.push(new TextDecoder().decode(raw));
    });
  } catch {}
  return { id, peers };
}

/**
 * OnlineResponse{ states=1 } —— states 是每个 peer 一个字节的位图
 * 0 = offline, 1 = online
 */
export function onlineResponse(states) {
  return wrap('OnlineResponse', [...bytesField(1, states)]);
}

/** HealthCheck{ token=1 } */
export function parseHealthCheck(inner) {
  return { token: readString(inner, 1) };
}

/** 32 字节 UUID 生成（RustDesk 用 16 字节 binary uuid，这里保持二进制） */
export function randomUuidBytes() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * RustDesk AddrMangle 编码（IPv4）
 * ---------------------------------------------------------------------------
 * 客户端用 AddrMangle::decode() 解 socket_addr，格式是位打包：
 *   v = ((ip + tm) << 49) | (tm << 17) | (port + (tm & 0xFFFF))
 * 其中 tm 是微秒时间戳的低 32 位，ip/port 都是 u32。
 * 输出为 v 的小端字节，去掉尾部 0。
 *
 * 之前用 TextEncoder 把 IP 字符串直接当字节，decode 出来是垃圾地址，
 * 导致 check_relay_request 的地址比对失败、RequestRelay 被静默丢弃。
 */
export function addrMangle(ip, port) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return new Uint8Array(0);
  }
  // ip 按小端打包成 u32（对应 Rust 的 u32::from_le_bytes(octets)）
  const ipU32 = (parts[0] | (parts[1] << 8) | (parts[2] << 16) | (parts[3] << 24)) >>> 0;

  // Rust 原式（全部 u128）：
  //   v = ((ip + tm) << 49) | (tm << 17) | (port + (tm & 0xFFFF))
  // 注意 ip+tm 与 port+(tm&0xFFFF) 都可能溢出各自字段宽度，
  // Rust 靠 u128 自然进位、decode 时再减回来。
  // 所以这里必须**完整保留进位**，不能提前掩码。
  const tmBig = (BigInt(Date.now()) * 1000n) & 0xffffffffn;

  const v =
    ((BigInt(ipU32) + tmBig) << 49n) |
    (tmBig << 17n) |
    (BigInt(port & 0xffff) + (tmBig & 0xffffn));

  const masked = v & ((1n << 128n) - 1n);
  const bytes = new Uint8Array(16);
  let x = masked;
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  // 去掉尾部 0（对应 Rust 的 n_padding 逻辑）
  let n = 16;
  while (n > 0 && bytes[n - 1] === 0) n--;
  return bytes.subarray(0, n);
}

/**
 * 反解 AddrMangle（与 Rust 的 decode 完全一致），仅用于自测。
 * 注意 decode 里 port 用的是 (number & 0xFFFFFF) - (tm & 0xFFFF)，
 * 而 encode 时 port 可能带进位到更高位，所以高位部分要靠 (number>>17)&0xFFFFFFFF 拿 tm。
 */
export function addrMangleDecode(bytes) {
  const padded = new Uint8Array(16);
  padded.set(bytes.subarray(0, Math.min(16, bytes.length)));
  let lo = 0n;
  for (let i = 7; i >= 0; i--) lo = (lo << 8n) | BigInt(padded[i]);
  let hi = 0n;
  for (let i = 15; i >= 8; i--) hi = (hi << 8n) | BigInt(padded[i]);
  const number = lo | (hi << 64n);

  const tm = (number >> 17n) & 0xffffffffn;
  const ipU32 = Number((((number >> 49n) - tm) & 0xffffffffn));
  const port = Number((number & 0xffffffn) - (tm & 0xffffn));

  const ip = [ipU32 & 0xff, (ipU32 >> 8) & 0xff, (ipU32 >> 16) & 0xff, (ipU32 >> 24) & 0xff].join('.');
  return { ip, port };
}

/** 解析 ip 文本里的端口，默认用 fallback */
export function ipPort(ipText, fallback) {
  const m = String(ipText).match(/^(\d+\.\d+\.\d+\.\d+)(?::(\d+))?$/);
  if (!m) return null;
  return { ip: m[1], port: m[2] ? Number(m[2]) : fallback };
}
