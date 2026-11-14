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

export { RdHub } from './hub.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return json({
        ok: true,
        service: 'rustdesk-cf-rdserver',
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
      const id = env.RD_HUB.idFromName('global');
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
