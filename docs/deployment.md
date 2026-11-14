# 服务端部署指南

## 前置条件

- Cloudflare 账号（免费版可用，但长时间远程桌面建议付费版）
- 一个托管在 Cloudflare 的域名（可选，但强烈建议——workers.dev 在国内常不可达）
- Node.js 18+
- wrangler CLI

---

## 步骤 1：部署 Worker

```bash
npm install -g wrangler
wrangler login
wrangler deploy --config wrangler-rdserver.toml
```

成功输出：
```
Uploaded rustdesk-cf-rdserver (2.04 sec)
Deployed rustdesk-cf-rdserver triggers (1.17 sec)
  https://rustdesk-cf-rdserver.<subdomain>.workers.dev
```

---

## 步骤 2：绑定自定义域名

### 方式 A：Cloudflare Dashboard

1. 进入 Workers & Pages → 选中 `rustdesk-cf-rdserver`
2. Settings → Triggers → Custom Domains → Add Custom Domain
3. 填入 `rd.example.com`，等待证书生效（约 1-2 分钟）

### 方式 B：API

```bash
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

### 方式 C：wrangler 配置

在 `wrangler-rdserver.toml` 里加：

```toml
routes = [
  { pattern = "rd.example.com", custom_domain = true }
]
```

---

## 步骤 3：配置 RELAY_SERVER 环境变量

编辑 `wrangler-rdserver.toml`：

```toml
[vars]
RELAY_SERVER = "rd.example.com"    # 改成你的域名，不要带端口和协议
HEALTH_TOKEN = ""
```

重新部署：

```bash
wrangler deploy --config wrangler-rdserver.toml
```

---

## 步骤 4：验证

```bash
# 健康检查
curl http://rd.example.com:8080/healthz

# 期望输出
{
  "ok": true,
  "service": "rustdesk-cf-rdserver",
  "routes": ["/ws/id", "/ws/relay", "/ (alias of /ws/id)", "/debug"],
  "ts": "2026-11-15T..."
}
```

### 跑协议测试

```bash
node rdserver/test-protocol.mjs ws://rd.example.com:8080
```

期望最后一行：
```
=== 全部通过 ===
```

测试覆盖：
- `RegisterPk` 注册
- `RequestRelay` 转发 + `socket_addr` 注入
- `RelayResponse` ACK 回显路由
- 两条 `/ws/relay` 配对
- 配对前字节缓冲

---

## 步骤 5：获取 Key

```bash
cat server-data/id_ed25519.pub
```

> 注意：自研 Worker 本身不校验 Key，但客户端会用它做加密握手，**必须填进客户端**。
>
> 如果没有这个文件，可以自己生成一个 32 字节随机数的 base64：
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
> ```
> 然后所有客户端都填同一个值。

---

## 本地开发

```bash
# 启动本地 Worker
wrangler dev --config wrangler-rdserver.toml --port 21118 --ip 0.0.0.0 --local

# 另开一个终端跑测试
node rdserver/test-protocol.mjs ws://127.0.0.1:21118
```

如果客户端只能连固定端口，用 `relay-proxy.mjs` 做端口转发：

```bash
node rdserver/relay-proxy.mjs --listen 21119 --target 21118 --host 127.0.0.1
```

---

## wrangler 配置说明

```toml
name = "rustdesk-cf-rdserver"
main = "rdserver/index.js"
compatibility_date = "2026-11-01"

# ⚠️ 不要加 [limits] cpu_ms —— Free 版不支持，会部署失败
# 报错：CPU limits are not supported for the Free plan

[[durable_objects.bindings]]
name = "RD_HUB"
class_name = "RdHub"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RdHub"]

[vars]
RELAY_SERVER = "rd.example.com"
HEALTH_TOKEN = ""

[observability]
enabled = true
```

---

## 多区域 / 多实例

不需要。Worker 天然在全球边缘运行，一个实例服务所有地区。

DO 的 `idFromName('global')` 保证所有设备连到同一个 DO 实例（这是必需的——设备表必须是全局的）。

---

## 更新部署

```bash
git pull
wrangler deploy --config wrangler-rdserver.toml
```

DO 状态（peer 表）存在 storage 里，重新部署不会丢失。但**已建立的 WebSocket 会断开**，客户端会自动重连。

---

## 成本

| 项 | 免费版 | 付费版（$5/月） |
|---|---|---|
| 请求数 | 10 万/天 | 1000 万/月 |
| CPU 时间 | 10ms/请求 | 30s/请求 |
| Durable Objects | 有免费额度 | 按需 |

**远程桌面的实际消耗**：中继是裸字节转发，每个数据帧算一次 DO 请求。1 小时远程桌面约几万到几十万次 DO 请求。

- 轻度使用（偶尔连一下）：免费版够
- 重度使用（每天几小时）：建议付费版

---

## 安全建议

1. **换掉默认 Key**：不要用示例里的 Key
2. **启用 `HEALTH_TOKEN`**：防止 `/healthz` 被公开探测
3. **不要公开 `/debug`**：它会暴露在线设备 ID 和 IP
4. **限制域名访问**：可在 CF 侧加 WAF 规则，只允许特定地区访问

如果要给 `/debug` 加保护，改 `rdserver/hub.js`：

```js
if (path === '/debug') {
  const token = url.searchParams.get('token');
  if (token !== this.env.HEALTH_TOKEN) {
    return new Response('forbidden', { status: 403 });
  }
  return json(await this.debug());
}
```
