/**
 * RustDesk on Cloudflare —— Worker 入口
 * ---------------------------------------------------------------------------
 * 把 RustDesk 的服务端（hbbs 信令 + hbbr 中继）整体重写成 Worker + Durable Object。
 * 纯 WebSocket，不依赖 UDP，因此可以在 Cloudflare 上跑。
 *
 * 路由：
 *   /ws/id          -> 信令通道
 *   /ws/relay       -> 中继通道
 *   /               -> 同信令通道（兼容客户端用 IP 时连 ws://ip:21118 不带路径）
 *   /healthz        -> 健康检查
 *   /debug          -> peer 表与中继队列
 *
 * 关键实现约束（踩过的坑，别改回去）：
 *   1. WebSocket 不能作为 RPC 参数跨 Worker→DO 传递，会触发
 *      "runtime canceled this request because your code had hung"。
 *   2. 必须由 DO 自己 new WebSocketPair() 并返回 101 响应，Worker 直接透传。
 *   3. DO 里不要检查 Upgrade 头 —— 经 stub.fetch 转发后可能被剥离。
 *   4. 返回 101 后，在 fetch() 里 addEventListener 注册的监听器会随请求结束
 *      被回收，消息永远收不到。必须用 Hibernatable WebSocket：
 *      state.acceptWebSocket() + webSocketMessage() 回调。
 *
 * 客户端寻址规则（hbb_common/src/websocket.rs::check_ws）：
 *   - 服务器地址是「域名」→ ws://域名[:websocket-port]/ws/id
 *   - 服务器地址是「IP」   → ws://ip:21118（固定端口，不带路径）
 *   因此本服务端同时接受 /ws/id 和根路径，两种配置都能用。
 */

export { RdHub, BUILD } from './hub.js';

import { BUILD } from './hub.js';

/**
 * 服务端版本号（定义在 hub.js，此处 import 复用，保证单一真源）。
 * ---------------------------------------------------------------------------
 * 用途一：/healthz 与 DO 的 /debug 都输出它，用来确认生产跑的是哪一版代码。
 * 用途二：作为 DO 实例名的后缀。**这是关键**——CF 的 DO 实例是长期存活的，
 *         部署新代码后，已存在的实例（尤其持有 WebSocket 长连接时）仍跑旧代码。
 *         把版本号拼进 idFromName，改版本号即自动创建全新 DO 实例，新代码立刻生效，
 *         不需要手工改名字。
 *
 * 改 hub.js / protobuf.js 里任何逻辑时，**必须同步提升 hub.js 里的 BUILD**，
 * 否则新代码不会生效（这是本项目最容易踩的坑）。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return json({
        ok: true,
        service: 'rustdesk-cf-rdserver',
        build: BUILD,
        doName: `global-${BUILD}`,
        routes: ['/ws/id', '/ws/relay', '/ (alias of /ws/id)', '/debug'],
        ts: new Date().toISOString(),
      });
    }

    const isWsPath =
      path === '/' ||
      path === '/ws/id' ||
      path === '/ws/relay' ||
      path === '/debug';

    if (isWsPath) {
      const isDebug = path === '/debug';
      if (!isDebug) {
        const up = (request.headers.get('Upgrade') || '').toLowerCase();
        if (up !== 'websocket') {
          return new Response('Expected 101 Switching Protocols', { status: 426 });
        }
      }
      // DO 实例名带版本号：改 BUILD 即自动切换新实例，新代码立刻生效。
      // 不这样做的话，已存在的 DO 实例（尤其持有 WS 长连接时）会一直跑旧代码。
      const id = env.RD_HUB.idFromName(`global-${BUILD}`);
      const stub = env.RD_HUB.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
