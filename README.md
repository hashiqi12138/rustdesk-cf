# RustDesk on Cloudflare

把 RustDesk 服务端（信令 + 中继）跑在 Cloudflare Worker + Durable Object 上，实现**全 NAT 后的跨内网远程桌面**。不需要公网 IP、不需要端口映射、不需要 VPS。

**已在以下组合实测通过：**
- Windows ↔ Windows（跨 IPv4/IPv6）
- 鸿蒙手机（HBN-AL80 / HarmonyOS 7.0.0.111）↔ Windows
- 网络环境：ISP 对 Cloudflare TLS 全段阻断，走明文 8080 端口绕过

---

## 为什么需要这个

标准 RustDesk 自建服务端需要一台有公网 IP 的机器，且要开放 21115-21119 端口。如果你：

- 所有设备都在 NAT 后面
- 没有公网 IP / 不能做端口映射
- 甚至 ISP 对 Cloudflare 的 TLS 握手有阻断

这套方案都能用——因为**所有连接都是设备主动出站**到 Cloudflare 边缘，NAT 和封锁都不再是障碍。

---

## 架构

```
设备 A（Windows / 手机 / 任意平台）
    ↓ ws://<域名>:8080/ws/id      （信令）
    ↓ ws://<域名>:8080/ws/relay   （中继）
Cloudflare Worker + Durable Object
    ↑ 同上，反向
设备 B
```

Worker 在 DO 内自己实现 RustDesk 的 protobuf 协议：
- `RegisterPk` / `RegisterPeer` 注册与保活
- `PunchHoleRequest` → 只回 `PunchHoleResponse(relay=...)`，强制走中继
- `RequestRelay` → 注入 `socket_addr`（AddrMangle 编码的主控地址）后转发
- `RelayResponse` → 用注入的 `socket_addr` 做 hex 匹配，原样回显给主控
- 两条 `/ws/relay` 按 uuid 配对，配对后纯裸字节转发

---

## 快速开始

### 1. 部署服务端

```bash
git clone <this-repo>
cd rustdesk-cf-public
npm install -g wrangler    # 或 npx wrangler

wrangler login
wrangler deploy --config wrangler-rdserver.toml
```

部署成功后会得到一个 `https://<worker-name>.<subdomain>.workers.dev`。

### 2. 绑定自定义域名

workers.dev 在国内经常不可达，建议绑自己的域名：

```bash
# 用 Cloudflare API
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/domains" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "hostname": "rd.example.com",
    "zone_id": "<ZONE_ID>",
    "service": "rustdesk-cf-rdserver",
    "environment": "production"
  }'
```

### 3. 修改 `wrangler-rdserver.toml` 里的 `RELAY_SERVER`

```toml
[vars]
RELAY_SERVER = "rd.example.com"    # 改成你的域名
```

重新 `wrangler deploy`。

### 4. 配置客户端

见下面的「客户端配置」章节。

---

## 客户端配置

### 关键前提：`relay-server` 必须写成完整 ws URL

这是**唯一一个容易踩死的坑**。RustDesk 源码 `rendezvous_mediator.rs` 里有个安全检查：

```rust
fn check_relay_request(&self, rr: &RequestRelay, now: Instant) -> ResultType<()> {
    if !is_reported_relay(&rr.relay_server, now)
        && check_port(&rr.relay_server, config::RELAY_PORT)
            != check_port(self.get_relay_server(String::new()), config::RELAY_PORT)
    {
        bail!("relay server {:?} was not offered by this peer", rr.relay_server);
    }
}
```

它比对**端口号**。如果一端写 `ws://域名:8080/ws/relay`（端口 8080），另一端只写 `域名`（默认 21117），两者不等 → **中继请求被静默丢弃** → 客户端报 `server returned an invalid connection response` 或「中继服务器不可达」。

**所以：所有设备的 `relay-server` 必须字面完全一致。**

推荐统一写成：
```
ws://rd.example.com:8080/ws/relay
```

---

### Windows 客户端

配置文件位置：`%APPDATA%\RustDesk\config\RustDesk2.toml`

```toml
rendezvous_server = 'rd.example.com:21116'
nat_type = 2
serial = 0
unlock_pin = ''

[options]
custom-rendezvous-server = 'rd.example.com'
allow-websocket = 'Y'
websocket-port = '8080'
relay-server = 'ws://rd.example.com:8080/ws/relay'
```

**说明：**
- `rendezvous_server` 的 `:21116` 是 RustDesk 的固定协议端口号，实际走 WebSocket
- `websocket-port = '8080'` 让客户端连 CF 的明文端口（绕过 TLS 阻断）
- `relay-server` 必须是完整 URL，见上面的说明
- **不要**配 `api-server`（Worker 不实现 REST API，配了只会刷心跳失败日志）

改完重启 RustDesk。

### 鸿蒙 / HarmonyOS 客户端

用 [ohos_rustdesk](https://atomgit.com/OpenHarmonyPCDeveloper/ohos_rustdesk) 移植版（包名 `com.example.remotedesktop`）。

App 内操作路径：**RustDesk 中继 → ⋯ → 编辑**

| 字段 | 填什么 |
|---|---|
| ID 服务器地址 | `ws://rd.example.com:8080/` |
| Key | 服务端 `id_ed25519.pub` 的内容 |
| Relay 地址 | `ws://rd.example.com:8080/ws/relay` |
| Relay 端口 | `8080` |

展开「高级设置」才能看到 Relay 地址和端口。

保存后卡片应显示「**在线 · N ms**」和「Key 已验证」。

**注意**：如果列表里出现 `RDP · x.x.x.x:3389` 这类条目，那是微软远程桌面协议，本 Worker 不支持，点了必然失败。

### 获取 Key

服务端首次运行会生成密钥对：

```bash
cat server-data/id_ed25519.pub
# 输出形如：n0Qwww9Jz9WqfLbP4cTlOZZicvYzDP1fiG0BHqkk+Og=
```

把这个值填到客户端的 Key 字段。

> 自研 Worker 本身不校验 Key，但客户端会用它做加密握手，**必须填**，否则连接被拒。

---

## 开机自启动

### Windows

`deploy/set-rustdesk-autostart.ps1` 会写 HKCU Run 键（无需管理员）：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\deploy\set-rustdesk-autostart.ps1
```

验证：
```powershell
(Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "RustDesk").RustDesk
```

**限制**：HKCU Run 在**用户登录后**才触发。如果机器无人值守（开机不登录），需要 SYSTEM 级计划任务（要管理员权限）：

```powershell
# 管理员 PowerShell
$exe = "$env:LOCALAPPDATA\rustdesk\rustdesk.exe"
Register-ScheduledTask -TaskName "RustDesk Autostart" `
  -Action (New-ScheduledTaskAction -Execute $exe) `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Principal (New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest) `
  -RunLevel Highest -Force
```

### 手机

鸿蒙版 RustDesk 的中继配置是应用内持久化的，App 启动即自动连接。保持 App 在后台不被清理即可。

---

## 网络环境适配

### 情况 A：能直连 Cloudflare TLS（443）

直接把 `websocket-port` 删掉、`relay-server` 改成 `wss://rd.example.com/ws/relay`、加上 `api-server = 'https://rd.example.com'` 即可走 TLS。

### 情况 B：TLS 被阻断（本项目的默认场景）

某些 ISP 对 Cloudflare 的 TLS 握手做了阻断（表现为 `os error 10054` / `Connection reset`）。但 CF 的**明文 HTTP 端口是放行的**。

CF 代理支持的端口白名单：
```
80, 443, 8080, 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096
```

**21116 / 21117 不在其中**，所以不能用 RustDesk 的标准端口，必须用 8080 + `/ws/id`、`/ws/relay` 路径。

诊断脚本见 `deploy/scan-cf.mjs`（扫 CF anycast IP 可达性）。

---

## 文件说明

```
rdserver/
  index.js          Worker 入口（路由 /ws/id、/ws/relay、/healthz、/debug）
  hub.js            Durable Object：信令 + ACK 路由 + 中继配对
  protobuf.js       RustDesk 协议最小 protobuf 编解码
  relay-proxy.mjs   本地开发用：21119 → 21118 端口转发
  test-protocol.mjs 协议级测试套件
  test-addrmangle.mjs AddrMangle 编解码自测

deploy/
  set-rustdesk-autostart.ps1   Windows 开机自启（HKCU Run）
  fix-182-relay.ps1            批量修正客户端 relay-server 为完整 URL
  share.mjs                    局域网文件分发（给其他机器拉脚本用）

wrangler-rdserver.toml         部署配置
docs/                          详细文档
```

---

## 排查

| 现象 | 原因 / 解法 |
|---|---|
| `中继服务器不可达` | ① `relay-server` 不是完整 ws URL ② 端口不是 8080 ③ CF 没代理该端口 |
| `server returned an invalid connection response` | `check_relay_request` 拒绝：两端 `relay-server` 字符串不一致 |
| `os error 10054` / `Connection reset` | ISP 阻断 CF TLS。改用明文 8080 |
| 主机卡片显示「未知」 | ID 服务器未连通，或目标设备不在线 |
| 日志刷 `Heartbeat failed ... :21114/api/heartbeat` | 配了 `api-server` 但 Worker 不实现 REST API。删掉该配置项 |
| 连上但画面不显示 | 检查两端是否都在 DO `/debug` 里 online |
| 每 20 多秒断线重连 | DO 心跳失效（本项目已内置 10s 空帧心跳，若改代码别删） |

### 调试端点

```bash
# 健康检查
curl http://rd.example.com:8080/healthz

# 当前在线设备 + 中继配对状态
curl http://rd.example.com:8080/debug
```

---

## 实现要点（改代码前必读）

1. **必须由 DO 自己 `new WebSocketPair()` 返回 101**
   WebSocket 不能作为 RPC 参数跨 Worker→DO 传递，会触发 `runtime canceled this request because your code had hung`。

2. **必须用 Hibernatable WebSocket**
   `state.acceptWebSocket()` + `webSocketMessage()` 回调。在 `fetch()` 里 `addEventListener` 注册的监听器会随请求结束被回收，消息永远收不到。

3. **心跳不能省**
   RustDesk 客户端在 WS 模式注册成功后**完全静默**，22.5 秒收不到服务端任何字节就断线重连。DO 每 10 秒向信令腿推 0 字节空帧，客户端会原样回显。
   **中继腿是配对后的裸字节流，绝对不能注入任何东西。**

4. **ACK 路由靠 `socket_addr` 注入**
   hbbs 转发 `RequestRelay` 时会注入 `socket_addr = AddrMangle(主控地址)`。被控端的 `RelayResponse` 原样回显该字段，Worker 用它的 hex 做键找回主控信令腿。
   **IPv6 需要兜底**：`addrMangle` 只认 IPv4，CF 边缘的 `cf-connecting-ip` 常是 IPv6，所以用 FNV-1a 折叠成合成 IPv4（hex 路由从不 decode，合成值无害）。

5. **CF 免费版不支持 `[limits] cpu_ms`**
   部署时不要加这个配置项。

---

## 已知限制

- **不支持 UDP**：RustDesk 的原生打洞走 UDP 21116，Workers 无 UDP 出站。本方案强制全部走中继（`PunchHoleResponse` 只回 `relay`）。
- **不支持 RDP 协议**：只实现 RustDesk 自己的协议。客户端列表里的 RDP 条目点了会失败。
- **不支持 hbbs REST API**：`/api/heartbeat`、`/api/sysinfo` 等未实现，配了 `api-server` 只会刷失败日志。
- **延迟**：明文 8080 端口首包可能 2-5 秒（线路特征），建立后稳定。中继延迟取决于两端到 CF 边缘的 RTT。
- **免费额度**：Workers 免费版有每日请求数和 CPU 时间限制。长时间远程桌面建议上付费版。

---

## 测试

```bash
# 协议级测试（本地或生产）
node rdserver/test-protocol.mjs ws://127.0.0.1:8899
node rdserver/test-protocol.mjs ws://rd.example.com:8080

# AddrMangle 编解码
node rdserver/test-addrmangle.mjs
```

---

## 相关项目

同一套思路的其它 Cloudflare 中继方案：

- **mesh-cf** —— WireGuard 组网（虚拟 IP，能互相 ping）
- **tunnel-cf** —— 反向端口隧道（电脑访问手机的调试端口）

---

## License

MIT
