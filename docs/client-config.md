# RustDesk 客户端配置模板

复制对应平台的配置，替换 `rd.example.com` 为你的实际域名。

---

## Windows

**文件位置**：`%APPDATA%\RustDesk\config\RustDesk2.toml`

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

### 字段说明

| 字段 | 作用 | 注意 |
|---|---|---|
| `rendezvous_server` | ID 服务器地址 | `:21116` 是协议固定值，实际走 WebSocket |
| `custom-rendezvous-server` | 同上，新版客户端用这个 | 只写域名，不带端口 |
| `allow-websocket` | 启用 WebSocket 模式 | 必须为 `Y` |
| `websocket-port` | WS 端口 | `8080`（CF 明文端口，绕 TLS 阻断） |
| `relay-server` | 中继地址 | **必须完整 ws URL**，见下方警告 |

### ⚠️ relay-server 必须是完整 URL

```toml
# ✅ 正确
relay-server = 'ws://rd.example.com:8080/ws/relay'

# ❌ 错误（端口会被解析成默认 21117，与其它端不匹配 → 中继被拒）
relay-server = 'rd.example.com'
relay-server = 'rd.example.com:8080'
relay-server = 'rd.example.com:21117'
```

**原因**：RustDesk 的 `check_relay_request` 比对端口号。两端字符串不一致 → 端口解析不同 → `bail!("relay server was not offered by this peer")` → 中继请求被静默丢弃。

### 不要配的项

```toml
# ❌ 不要加：Worker 不实现 hbbs REST API
api-server = 'https://rd.example.com'
```
加了只会让日志刷 `Heartbeat failed: ...:21114/api/heartbeat`。

---

## 鸿蒙 / HarmonyOS

用 [ohos_rustdesk](https://atomgit.com/OpenHarmonyPCDeveloper/ohos_rustdesk) 移植版。

### App 内操作

1. 打开 RustDesk
2. 找到「**RustDesk 中继**」卡片
3. 点右侧「**⋯**」
4. 点「**编辑**」
5. 展开「**高级设置**」（Relay 地址和端口在这里）
6. 填写下表
7. 点「**保存并验证**」

### 填写内容

| 字段 | 值 |
|---|---|
| ID 服务器地址 | `ws://rd.example.com:8080/` |
| Key | 服务端 `id_ed25519.pub` 的内容 |
| ID 服务器端口 | `21116` |
| Relay 地址 | `ws://rd.example.com:8080/ws/relay` |
| Relay 端口 | `8080` |

### 验证成功的样子

卡片显示：
```
RustDesk 中继
ws://rd.example.com:8080/
在线 · 3795ms
· 1台
仅中继 · Key 已验证
```

### 连接设备

在「远程主机」页面的输入框里输入目标设备的 ID，然后点「连接」。

**注意**：列表里如果有 `RDP · x.x.x.x:3389` 条目，那是微软远程桌面协议，本方案不支持，点击必然报 `invalid connection response`。

---

## 其它平台（macOS / Linux / Android / iOS）

官方 RustDesk 客户端，在「设置 → 网络」里填：

| 字段 | 值 |
|---|---|
| ID 服务器 | `rd.example.com` |
| 中继服务器 | `rd.example.com` |
| API 服务器 | 留空 |
| Key | 服务端 `id_ed25519.pub` 的内容 |

如果客户端支持 WebSocket 端口设置，填 `8080`。

如果只能填服务器地址而无法指定 WebSocket 端口，则需要能直连 CF TLS（情况 A），或者用 `deploy/fix-182-relay.ps1` 类似的方式直接改配置文件。

---

## 获取 Key

```bash
# 在部署服务端的机器上
cat server-data/id_ed25519.pub
```

输出示例：
```
n0Qwww9Jz9WqfLbP4cTlOZZicvYzDP1fiG0BHqkk+Og=
```

整个值（包括末尾的 `=`）都要填进客户端。

---

## 多设备一致性检查

所有设备的 `relay-server` 必须**字面完全相同**。快速检查：

```powershell
# Windows 各机器上执行，输出应该一模一样
(Get-Content "$env:APPDATA\RustDesk\config\RustDesk2.toml" | Select-String 'relay-server').Line
```

手机端在「编辑」表单里看「Relay 地址」字段的值。
