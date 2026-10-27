# 正式域名与版本化发布收尾

## 当前已完成

- 三域名 `models.cogine.ai`、`models.cogine.app`、`models.cogineai.com` 的 Cloudflare Pages verification／certificate validation 均为 active；实际 HTTPS `/rankings.json` 均返回200、614模型和相同公开 revision `47eb9794f9ad3f8a69cc4de6f0159499fe3e358bb6d7589be221b2eb0ed82d6c`。Google 与 Cloudflare 公共 DNS 均返回已登记 Pages CNAME。
- Pages 生产配置与随仓库 Wrangler 配置的正式 origin 改为 `https://models.cogine.ai`；原有 `PUBLIC_DATA` 只读 binding 保持专桶 `modelspage-production`。已单独重建当前 main，部署 `35fa99b4-54b1-4fe0-8963-3716b5a2efbb` 成功；三个域名各14条页面/API及 CORS 预检均通过，分享图元数据均使用正式 origin，排名 JSON 完整字节一致。
- GitHub production 已填写正式 public base URL、R2 account 与 bucket。真实专桶凭据与条件写验证通过后，将两项 S3 Secrets 经标准输入写入该 environment 并开启生产发布；仓库级输入解密 secret 已有，无需复制到聊天或仓库。

## 审核 PR #3 的整合

审核范围原为 `f5db533791b4eb6df8408dbdffa65a5d686be08d` → `a90d71a8f1fcdab71841cbd9473ae2a30be8725f`。上游固定输入升级至 `dde15ad9b8c0903ea4e26da44e637c4fd880e9a9`，原公开网页与本项目新增页面继续共存。

静态审核确认 parser／schema／translate 为上游 v2 演进，构建导入图没有新增凭据读取、网络或模块执行副作用；sync provider 代码不在生产构建导入图中。补接自有 worker 对重复 `type`、实验 v2 单类／多类过滤的支持；两轮真实 RED→GREEN 后，17项 worker 测试／190断言通过。原 API 默认行为、CORS、条件读取与严格 R2 路径保持不变。

Canonical 来源时间改用 `lock.synced_at ?? lock.imported_at`，与原上游 adapter 一致；不把10月27日的新目录标成10月25日已取得。两个旧兼容性测试更新 fixture：新 parser 合法的 audio 不再用作失败样本，改用未设 `v2_only` 的 extraction；非法 tools.search 对象按现有实现剥离完整 tools 容器。没有改日期信任、投影、身份边界或公开 schema。

本项目208项测试／1391断言、两套类型检查、目录 `bun validate` 和 v1 对固定 `dde15ad9b` byte-identical 检查已通过。CI 同步加入目录 validate 与固定基线 v1 检查。

额外运行上游原测试为720通过／10失败，涉及原 GitHub Copilot／Hyper／Eden AI／DeepInfra／LLM Gateway／Vercel sync断言以及缺失 weights 数据。`git diff --quiet dde15ad9b -- models providers packages/core` 返回0，确认这些代码、测试与模型资料原样来自固定上游输入；未为上线修改上游断言或补造来源。这一组不报告为 PASS，失败详情保存在本地 `production-core-tests.log`。

## R2 凭据配置与真实条件写

原有 Wrangler OAuth 对 account／user token 创建均返回403/code9109。改用官方 `cf@1.0.0-beta.23` 请求账号读取、创建账号 Token、R2 对象读写及离线登录，首次一般授权后未取得 `account_api_tokens:create`，创建专桶 account token 仍返回403。

真实 CLI consent 页面确认：`Sensitive scopes → Account API Token Provisioning` 是单独的开关，一般 Authorize 不包括这个默认关闭的能力。账号 membership 是 `Super Administrator - All Privileges`，没有修改角色。数次设备码到期后，用户明确开启敏感权限并授权，CLI 回读 scope 确认含 `account_api_tokens:create`，随后官方 CLI 创建专桶 account token 成功。

凭据仅允许 `modelspage-production` 的 Bucket Item Write（含对象读写/list），permission group 为 `2efd5506f9c8494dacb1fa10a3e7d5b6`，resource 精确为 `com.cloudflare.edge.r2.bucket.a11312197b2f8ff3e535b8c2f4ac9b22_default_modelspage-production`。创建结果的 policy 已逐项校对。没有复用 CogineWork 桶凭据，没有把 OAuth／refresh token复制到 CI。S3 凭据保存在本地被忽略的0600文件，写入 GitHub 时使用标准输入，本记录与日志不含秘密值。

真实 S3 验证已通过：隔离对象上的两个 `If-None-Match:*` 并发写返回412／200；正确 ETag 更新成功；旧 ETag 更新和重复创建均为412，失败写没有改变对象内容；两个基于同一 ETag 的并发更新为412／200。探针位于 Worker 不公开的独立 prefix，已删除。收据：本地 `.modelspage/r2-cas-live.json`。

下一步验收：审核 PR 合并触发生产发布、不可变 catalog 公网 hash、manifest 条件切换，以及更新后三个域名 API／CORS／条件读取。未完成项不记为通过。
