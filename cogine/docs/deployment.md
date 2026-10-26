# R2 分发、失败恢复与回退

生产分发实现位于 [`store.ts`](../src/store.ts) 和 [`publish.ts`](../src/publish.ts)。2026-10-26 已使用本地 Wrangler 在账户 `a11312197b2f8ff3e535b8c2f4ac9b22` 创建专用 `modelspage-production` 桶，并通过 Cloudflare API 读回确认。桶为 Standard/APAC，无自定义域名，r2.dev 访问关闭，没有发布目录或 manifest。当前登录未列出可用 zone，正式域名待补充；专桶 S3 凭据和公开读取尚未验收。默认 `MODELSPAGE_PUBLISH_ENABLED=false`，服务尚未上线。

首发决策：主要 Provider 和模型的 C/P/N 应有广泛覆盖后再上线；范围和来源选择记录在[约束审计](2026-10-26-constraints-review.md)。不能把每类仅一条事实当成业务覆盖验收完成。

审核 PR 合并到 main 后，workflow 通过只读 GitHub API 核实 exact merge commit 及当前 main SHA，再执行已启用的 production 发布；保留手动重试。它从已验证的当前 manifest 自动派生下一发布序号，以可信提交时间形成固定构建时钟，无需每次人工填序号和时钟。开关关闭时不会写入生产；已有有效版本后的纠错和撤回仍可发布。

## DNS 交付安排

DNS 由用户在现有 DNS 平台手动配置，统一留到部署准备的最后一步交付，不分批要求用户修改。先完成可独立推进的应用、数据和云端配置，再提供一张完整记录表：域名、DNS 管理平台、记录类型、主机名、实际目标值、TTL、代理状态和验证方式。记录值必须来自平台实际分配和确认，未取得的值明确标为待生成，不把示例或 r2.dev 地址当正式目标。

候选入口为 `models.cogine.ai`（Spaceship）、`models.cogine.app`（Vercel）及 `models.cogineai.com`（当前 NS 查询为 DNSPod）。建议一个正式数据源，其他入口共用该版本或重定向。最终清单需覆盖实际选用的入口及所有权/证书验证记录；如接入方式涉及 nameserver 变更，应单独列出其范围，不能混作普通 CNAME。用户完成 DNS 后再执行公开路径、证书及缓存验收，在此之前这些检查保持未执行状态。

当前 R2 自定义域名要求 zone 位于桶所在 Cloudflare 账户；保留外部权威 DNS 的 partial setup 需要 Business 或 Enterprise，接入方式尚未落实。不能假定在三个现有 DNS 平台分别添加一条 CNAME 就已满足该要求。参见 [R2 自定义域名](https://developers.cloudflare.com/r2/buckets/public-buckets/#add-your-domain-to-cloudflare) 和 [partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)。本轮没有迁移 DNS、开通付费计划或发布生产数据。

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
2. 在同一 Cloudflare account 下把实际受控的自定义域名连接到桶，等待 Active。填入真实的 HTTPS origin 到 MODELSPAGE_PUBLIC_BASE_URL，不填路径、凭据、查询参数或 r2.dev。自定义域名支持 Cloudflare 缓存；r2.dev 用于非生产场景，见 [R2 公共桶文档](https://developers.cloudflare.com/r2/buckets/public-buckets/)。
3. 设置 [`.env.example`](../../.env.example) 中的非秘密配置。GitHub 使用 `production` environment：Variables 为 MODELSPAGE_PUBLIC_BASE_URL / MODELSPAGE_R2_ACCOUNT_ID / MODELSPAGE_R2_BUCKET / MODELSPAGE_PUBLISH_ENABLED；Secrets 为 MODELSPAGE_R2_ACCESS_KEY_ID / MODELSPAGE_R2_SECRET_ACCESS_KEY。建议为该 environment 配置受保护分支及所需审核者。
4. 为 manifest 配置明确的 Cloudflare Cache Rule：精确 `/v1/manifest.json` **Bypass cache**，浏览器尊重源 Cache-Control。为 `/v1/revisions/` 配置 Eligible for cache，Edge TTL 尊重源 Cache-Control，确保 JSON 也可缓存；不以全站 Edge TTL 规则覆盖 manifest。设置依据见 [Cache Rules 文档](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)。
5. 若浏览器跨域直接读取，给桶配置只读 CORS：实际消费 origin、GET/HEAD，允许 If-None-Match 与 Cache-Control 请求头，ExposeHeaders 包含 ETag。测试应带 Origin；已有 CDN 对象可能需刷新才能获得新 CORS 头，见 [R2 CORS 文档](https://developers.cloudflare.com/r2/buckets/cors/)。桌面宿主自行读取时不必为并不存在的浏览器来源开放 CORS。
6. 按来源逐一审核采集和公开派生用途。代码 MIT 许可不能替代 OpenRouter 等第三方数据条件。先通过 PR 提交来源配置、精确映射和必要逐项覆盖证据，再手动发布。

本实现通过 S3 SDK 的 PutObject IfMatch / IfNoneMatch 条件写，不依赖 workflow 排队来冒充 CAS。Cloudflare 文档说明这些条件与实际对象写入原子评估，见 [R2 S3 扩展](https://developers.cloudflare.com/r2/api/s3/extensions/)；真实目标桶的功能与权限仍需首次上线前验证。

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
