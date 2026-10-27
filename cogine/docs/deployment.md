# 版本化 R2 数据分发、失败恢复与回退

正式网站为 [models.cogine.ai](https://models.cogine.ai/)，另两个域名共用同一版本。网站 `/rankings.json` 和版本化 [`/v1/manifest.json`](https://models.cogine.ai/v1/manifest.json) 均已上线；两个合同分别服务 canonical 排名与带精确 Provider 身份的资料。域名、真实条件写及合并后自动发布的验证见[正式发布验收](2026-10-28-production-release.md)。

版本化分发实现位于 [`store.ts`](../src/store.ts) 和 [`publish.ts`](../src/publish.ts)。专用桶为账户 `a11312197b2f8ff3e535b8c2f4ac9b22` 的 `modelspage-production`（Standard/APAC）。桶保持私有，r2.dev 关闭，网站通过只读代码路径的 R2 binding 分发。GitHub production 的两项专桶 S3 secrets、四项发布变量已配置，`MODELSPAGE_PUBLISH_ENABLED=true`；首版 sequence 1 已发布并从三个域名核对完整 hash。

首发决策：主要 Provider 和模型的 C/P/N 应有广泛覆盖后再上线；范围和来源选择记录在[约束审计](2026-10-26-constraints-review.md)。不能把每类仅一条事实当成业务覆盖验收完成。

审核 PR 合并到 main 后，workflow 通过只读 GitHub API 核实 exact merge commit 及当前 main SHA，再执行已启用的 production 发布；保留手动重试。它从已验证的当前 manifest 自动派生下一发布序号，以可信提交时间形成固定构建时钟，无需每次人工填序号和时钟。开关关闭时不会写入生产；已有有效版本后的纠错和撤回仍可发布。

## DNS 交付安排

DNS 由用户在现有 DNS 平台手动配置，统一留到部署准备的最后一步交付，不分批要求用户修改。先完成可独立推进的应用、数据和云端配置，再提供一张完整记录表：域名、DNS 管理平台、记录类型、主机名、实际目标值、TTL、代理状态和验证方式。记录值必须来自平台实际分配和确认，未取得的值明确标为待生成，不把示例或 r2.dev 地址当正式目标。

已生效入口为 `models.cogine.ai`（Spaceship）、`models.cogine.app`（Vercel）及 `models.cogineai.com`（DNSPod）。三个 `models` CNAME 均指向 `modelspage.pages.dev`，verification／certificate validation 均 active，HTTPS、API、缓存头、CORS 和条件读取已分别回读验收。主地址为 models.cogine.ai；没有迁移主域 NS。

网站目前使用 Pages 子域名接入和私有 R2 binding，外部 DNS 的子域名可以直接 CNAME 到实际 Pages hostname，绕开了直接给桶绑定域名的限制；无需迁移 NS 或开通 Business。只有今后选择 R2 自定义桶域名时，才适用[同账户 zone](https://developers.cloudflare.com/r2/buckets/public-buckets/#add-your-domain-to-cloudflare)／[partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)的条件，不再把它们作为整个网站的部署阻塞。

## 本地模拟

```sh
bun run build:fixture
bun run validate:release --input dist/fixture
bun run publish:dry-run
bun run publish:dry-run
```

第二次返回 unchanged。修改 fixture 后如果仍用同一序号，旧模拟桶会拒绝不同内容；使用新的 `--state-dir` 开始独立模拟，或采用更高序号。模拟桶在 `.modelspage/dry-run/`，每条对象记录同时保存字节、ETag、Content-Type 和 Cache-Control；本地锁内执行条件比较与原子替换。它能验证发布协议和持久化恢复，不等于已验证真实 Cloudflare 认证、网络或 CDN。进程异常终止可能留下 `.write-lock`；确认没有运行中的写入进程后，才可移除这个空锁目录重试。

## 配置生产

1. 创建只用于 Modelspage 的 R2 桶，生成只允许访问该桶的读写 S3 凭据；不复用 CogineWork 正式资产桶。
2. 将实际域名连接到 Pages 项目并等待 Active，以 `PUBLIC_DATA` binding 读取私有专桶。`MODELSPAGE_PUBLIC_BASE_URL` 填正式 HTTPS origin，本项目为 `https://models.cogine.ai`；不需要给桶单独开公共域名或迁移 NS。
3. GitHub 使用 `production` environment：Variables 为 MODELSPAGE_PUBLIC_BASE_URL / MODELSPAGE_R2_ACCOUNT_ID / MODELSPAGE_R2_BUCKET / MODELSPAGE_PUBLISH_ENABLED；Secrets 为 MODELSPAGE_R2_ACCESS_KEY_ID / MODELSPAGE_R2_SECRET_ACCESS_KEY。输入解密 key 沿用项目 repository secret。代码与本地样例默认关闭发布，真实生产环境显式启用。
4. Worker 对 manifest 每次直接读取 R2，返回 `max-age=0, must-revalidate`；revision 返回一年 immutable。没有使用 Cache API 缓存 manifest；若以后添加 zone Cache Rule，不得覆盖此行为。当前验收覆盖真实 Cache-Control、ETag、304、HEAD 与错误 If-Match 的412。
5. 跨域由 Pages Worker 提供，只读 GET/HEAD/OPTIONS，并暴露 ETag、Last-Modified、Cache-Control 和 Content-Length。浏览器不直接读取私有桶，因此不需要配置桶公共 CORS。实际预检及读取分别验证。
6. 通过 PR 维护来源配置、精确身份和用途依据。代码 MIT 许可不能替代第三方数据许可；AA/OpenCode 的本项目公开范围已由所有者确认。合并后自动发布，手动运行保留作恢复或重试。

本实现通过 S3 SDK 的 PutObject IfMatch / IfNoneMatch 条件写，不依赖 workflow 排队来冒充 CAS。Cloudflare 文档说明这些条件与实际对象写入原子评估，见 [R2 S3 扩展](https://developers.cloudflare.com/r2/api/s3/extensions/)；真实目标桶的并发创建、并发更新和旧 ETag 拒绝均已验证。

## 发布协议

```sh
bun run build --published-at 2026-10-26T00:00:00.000Z --sequence 1 --out-dir dist/production
bun run validate:release --input dist/production
bun run publish --input dist/production
```

已有生产版本时，先运行 `bun cogine/src/cli.ts fetch-current --out-dir .modelspage/active`（读取 MODELSPAGE_PUBLIC_BASE_URL），再向 build 传入 `--previous .modelspage/active/catalog.json`。只有 manifest 明确返回 404 才按首次发布处理；网络、hash、结构和对象缺失错误都会停止。生产 workflow 已自动执行这个步骤，保留最后有效事实、profile、署名和纠错。

样例时钟/序号须替换为目标环境真实发布计划。首次生产开启前先做相同输入的 dry-run，确认覆盖报告、来源许可和 N 可信范围。CLI 不打印凭据；不要打开 SDK 请求调试日志。

1. 校验 catalog 全部事实、来源许可、完整性、schema、revision、hash、大小及兼容性。
2. 检查当前 manifest 的 publication_sequence，旧序号和同序号不同内容拒绝。
3. 数据和构建输入未变、仅传入新时钟或序号时，保留当前 manifest 和资料时间。
4. revision 对象仅 If-None-Match:* 创建；已存在时要求字节和 HTTP 元数据完全一致。
5. 从 R2 读回字节和元数据，并从自定义域名公开路径检查内容 hash、Content-Type、Cache-Control、ETag。
6. 最后切换 `/v1/manifest.json`：已有对象用其 ETag 的 If-Match，首次用 If-None-Match:*。条件失败重读、重新比较，不无条件重试。
7. 校验新 manifest 的读取结果与公开路径。旧版本默认保留；没有自动清理策略。

revision 对象使用 `application/json; charset=utf-8`、`public, max-age=31536000, immutable`。manifest 使用相同 JSON Content-Type 和 `public, max-age=0, must-revalidate`。ETag 是不透明条件令牌；完整性使用 manifest 中的 SHA-256。

多个对象写入不构成事务；manifest 是最后的切换指针。失败发生在切换前，旧 manifest 仍有效；上传到一半的不可变对象可以保留并重新运行同一构建。写 manifest 后公开校验失败不能简单假定已回滚，应读取 R2 和公开 manifest，修复 DNS/缓存规则，再按下面步骤推进一个更高序号。

## 回退与撤回

先读取当前 manifest，选比当前序号更高的数。旧版本必须仍通过 schema、hash 和来源许可验证：

```sh
bun run rollback --input dist/previous-verified-release --sequence 3 --published-at 2026-10-26T01:00:00.000Z --dry-run --state-dir .modelspage/dry-run
```

去掉 `--dry-run` 及 `--state-dir` 才执行真实发布。回退只以更高序号指向原来的不可变 catalog，不改旧对象或降低序号。若旧 catalog 丢失已经生效的替换纠错、撤回或冲突，发布器和客户端都会拒绝应用；应先以旧业务输入加当前纠错 ledger 重建。纠错内容需要变更时，提交更高字段 sequence 的明确审核动作，再发布新的更高发布序号版本。

撤回在 corrections 配置中提交明确记录及审核依据，通过 PR 后发布更高序号。客户端在正常后台检查周期内收到；不能承诺立即撤回全部离线缓存。

同环境 GitHub workflow 用 concurrency 串行；R2 的条件写及序号比较仍负责阻止旧构建、外部发布器或并发工作流覆盖新版本。

## 每日加密排名输入

当前 reviewed-main build 需要 `MODELSPAGE_INPUT_ENCRYPTION_KEY` 解密同 commit 的 `cogine/data/rankings.json`，只在可信 build 步骤注入；AA/OpenRouter API key 仅每日采集使用，发布不重新联网采样。未通过许可/首发检查的明文候选不能作为 Actions artifact 上传，公开生产 artifact 仅在成功发布后上传。三个项目专用 repository secrets 已配置；R2 写凭据与生产开关位于单独的 production 环境。两条自动部署流程已实跑成功，见[发布验收](2026-10-28-production-release.md)与[每日流程](2026-10-27-daily-cpn-integration.md)。
