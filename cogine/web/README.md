# Web

直接复用 `packages/web` 的 models.dev 网站。Models、Providers、Labs、三类详情、搜索、表格排序、复制和原 JSON API 保留；独立增加 `/rankings`、`/data` 与 `/rankings.json`。

网站已部署到 **https://modelspage.pages.dev/**。正式子域名的 DNS 配置、平台状态及验证见[公网部署记录](../docs/2026-10-28-public-deployment.md)。

## 公网构建

Cloudflare Pages 项目为 `modelspage`，Git 来源为 `cogine-ai/modelspage` 的 main。生产构建使用 Bun 1.4.4，先以固定提交时钟从已审核加密输入构建 C/P/N，再生成整套站点、公开 `/rankings.json` 及其 JSON schema。只有公开许可和实际 C/P/N 检查通过后，数据集才标为 `audience: public`；不会将本地候选直接上传。

```sh
MODELSPAGE_WEB_ORIGIN=https://modelspage.pages.dev bun --env-file .env.daily run web:release
```

密钥只在构建进程内解密输入，不进入网站。Cloudflare 保存项目专用的输入解密 secret；网页代码不需要 AA/OpenRouter API key。`MODELSPAGE_WEB_ORIGIN` 使用实际 HTTPS 公网 origin；禁止把 localhost 当作公网构建地址。

自有 `_worker.js` 保留原 API 的 `?type=`、schema 和实验 v2，提供只读跨域和条件请求。静态页面使用 Pages 原生路由与真实 404，不复用原 SST/遥测代码。专桶通过 `PUBLIC_DATA` binding 暴露严格限定的 `/v1/` 读取路径，桶中尚无正式 manifest 时真实返回 404。该版本化渠道与网站 `/rankings.json` 是不同合同，不能把网站部署成功冒充 R2 数据发布。

## 本地开发

使用仓库固定的 Bun 1.4.4，在仓库根目录运行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run web:dev
```

原开发服务器默认页面端口 3000、资产端口 16000，可用 `PORT`、`ASSET_PORT` 指定。没有排名输入时仍可浏览原目录及 N，C/P 保持未知。

预览已有的本地验证结果时，显式给出已构建 `catalog.json` 的绝对路径。此文件不是 models.dev 原目录 JSON，而是本项目带版本和来源的 C/P/N Bundle：

```sh
MODELSPAGE_WEB_CATALOG=/absolute/path/to/catalog.json bun run web:build
PORT=8183 bun run web:preview
```

构建输出在 ignored `packages/web/dist/`。本地静态预览只监听 `127.0.0.1`，保留原 API 的 `?type=` 语义。`/data` 的全量目录下载使用 `?type=all`，原 API 的默认类型行为不变。不要用上游 `sst.config.ts` 部署这份本地预览。

本站 favicon 和分享图在 `assets/`；上游 `packages/web/public/` 的旧品牌图片保留作源码参考，不进入本站构建。分享 PNG 从本目录新写的 SVG 导出，不依赖上游图像。正式构建时将 `MODELSPAGE_WEB_ORIGIN` 设为最终的站点 origin，生成绝对分享图 URL；本地预览会使用当前请求的 origin，帮助中的 API 示例也始终使用浏览器当前 origin。

原 MIT 版权和许可全文保留在根 `LICENSE`，构建会另外生成 `/licenses/models-dev.txt`，并在 JS/CSS 中保留许可通知。帮助与 Data 页提供简短的来源/许可链接。本站品牌、接口示例与贡献入口使用 Modelspage；真实数据来源、上游 SDK、内部 `@models.dev/core` 名称和厂商标识不改成本站品牌。详细走查见[品牌与来源记录](../docs/2026-10-28-web-branding-and-attribution.md)。

新增组件、样式、客户端和数据投影在本目录；上游 web 只增加导航和入口挂接。图表使用真实数据绘制，P 不重新计算权重；缺失值不补零，先建立完整排序再过滤。默认价格复用原站各 Provider 最低输入／输出价格的独立聚合。原站目录和排名 Bundle 的来源版本分别保留。

`/rankings.json` 是 canonical 模型投影：本地模式标记 `audience: local-preview`，正式构建标记 `public` 并符合 `/rankings.schema.json`。Provider 专属、未关联 canonical 的成员仍在原 Provider 页面和完整原目录中；这里不凭名称把它们合并到 canonical 榜单。它没有替代现有 `/v1/manifest.json` / revision 合同，版本化 R2 数据渠道继续沿用原发布协议。

验证：

```sh
bun run typecheck:web
bun run typecheck
bun test cogine/test
bun validate
bun run v1:check 4f1231e6bf72d5fa66dc1163599eaaedb607faab
```

当前复现证据见 [`2026-10-28-web-reproduction.md`](../docs/2026-10-28-web-reproduction.md)。
