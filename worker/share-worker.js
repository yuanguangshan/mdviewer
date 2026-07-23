/**
 * md-editor 协作分享 Worker（Cloudflare）
 * ---------------------------------------------------------------
 * 部署说明（在 Cloudflare 面板操作，本文件不参与前端静态站点构建）：
 *   1. 创建一个 R2 存储桶（例如 bucket 名：share）。
 *   2. 创建一个 Worker（例如 md-share-worker），把本文件内容粘贴进
 *      Worker 的编辑区并部署。
 *   3. Settings → Variables → R2 Bucket Bindings，将桶绑定为变量
 *      名 R2_BUCKET（代码里用 env.R2_BUCKET 访问）。
 *   4. 给 Worker 分配一个【独立】的路由 / 自定义域名，例如
 *      share-api.want.biz。
 *      ⚠️ 重要：不要把 Worker 和 R2 存储桶的「公开访问自定义域」
 *      （如你已有的 share.want.biz）指向同一个域名，否则 DNS/CNAME
 *      会冲突，两者都不可用。Worker 与桶的公开域必须各用各的域名。
 *   5. 前端 app.js 里的 R2_WORKER_URL 改成第 4 步的 Worker 域名。
 *
 * 设计要点：
 *   - 链接即密码：key 由 crypto.randomUUID() 前段生成，无法被猜到。
 *   - 开放 CORS(*)：前端是静态站点（可能在不同域名），需要跨域读写。
 *   - 无鉴权：任何人拿到链接即可读写该 key，因此只放「决定分享出去」
 *     的内容，私人文档仍留在本地 IndexedDB / NAS。
 *   - 加 no-store：避免边缘节点缓存导致好友改完你还看到旧版。
 */
export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };

    // 1. 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 路径即 key，例如 /a1b2c3d4.md
    let key = new URL(request.url).pathname.slice(1);

    // 2. 上传 / 更新文档（POST 新建、PUT 覆盖）
    if (request.method === 'POST' || request.method === 'PUT') {
      if (!key) key = crypto.randomUUID().split('-')[0] + '.md';

      // 限流：单文件 ≤ 2MB，防止被刷流量
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 2 * 1024 * 1024) {
        return new Response('File too large', { status: 413, headers: corsHeaders });
      }

      await env.R2_BUCKET.put(key, buffer, {
        httpMetadata: { contentType: 'text/markdown;charset=utf-8' }
      });
      return new Response(JSON.stringify({ id: key }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. 读取文档
    if (request.method === 'GET') {
      if (!key) return new Response('Not Found', { status: 404, headers: corsHeaders });
      const obj = await env.R2_BUCKET.get(key);
      if (!obj) return new Response('Not Found', { status: 404, headers: corsHeaders });
      return new Response(obj.body, {
        headers: { ...corsHeaders, 'Content-Type': 'text/markdown;charset=utf-8' }
      });
    }

    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
};
