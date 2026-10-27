# 正式域名与版本化发布收尾

## 当前已完成

- 域名接入早期检查（目录升级前）：三域名 `models.cogine.ai`、`models.cogine.app`、`models.cogineai.com` 的 Cloudflare Pages verification／certificate validation 均为 active；实际 HTTPS `/rankings.json` 均返回200、614模型和相同公开 revision `47eb9794f9ad3f8a69cc4de6f0159499fe3e358bb6d7589be221b2eb0ed82d6c`。Google 与 Cloudflare 公共 DNS 均返回已登记 Pages CNAME。当前覆盖为617模型、C200／P54／N615，详见下文首轮自动发布记录。
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

## 审核合并后的首轮自动发布

PR #3 经上述代码审核与 CI 后转为 ready，合并为 main `0e1950a98dcb0d14d0e3932e7bfd1e0eb605f4dd`。两条真实 push 链路均成功：

- [版本化发布运行40577107798](https://github.com/cogine-ai/modelspage/actions/runs/40577107798)：识别 exact merged PR／当前 main；首次读取 manifest 为404；派生 sequence 1；构建、校验、C/P/N 准入、不可变上传／远端与公开回读、manifest 条件切换全部成功。
- [主分支 CI 40577107392](https://github.com/cogine-ai/modelspage/actions/runs/40577107392) 成功。
- Cloudflare Git 自动部署 `ba558214-8d26-465f-82d4-7a431dec8e7a` 成功，触发类型 `github:push`、commit 为同一 main；正式网页已回读。

首次版本化 revision 为 `af8541539198b157589c7608c535f49fd352f94522f174a14c053ad528aa0f6d`，catalog 36,050,103字节，SHA-256 `ec2064a99685a237dd27c69639f39a2c531aa75d12be1a4a31dbeb2da2e3d7d5`。共11,916条精确身份／协议事实；发布器准入计数 C6766／P3326／有效日精度N11890，不把这些条数冒充独立模型数量。

三个域名的 manifest 完整字节 hash 都是 `41fb6704d8ccf85f43333aa3cd7706734accf5fe80def6d9197befffd765b42a`；catalog 逐字节相同，并通过 size、bundle revision、JSON schema、来源／profile 再分发和兼容性校验。manifest／revision 条件 GET 都为304，revision HEAD为200，CORS预检204，错误 If-Match为412，公开 POST为405。读取路径没有给予公共写能力。

网站 canonical 排名为617模型、C200／P54／N615，revision `607ceb319d52e1bef785a59ee2a43c0cd0f63160694e00c73991053f80078303`，三域名排名 JSON 字节 hash 均为 `df384a4862505fad20d4b73610577a603c0760d6b318cbf9fa000a217f3aba45`。原页面／API每域14条和 CORS通过；每域另外核对4类 API重复 `type=chat&type=image`、实验v2的 `type=decision` 及非法类型400，共15项过滤结果检查通过。

Data 页补上现已可用的 `/v1/manifest.json` 入口。外网、S3认证、真实 CAS、生产发布和公开 API 验收分别完成；没有执行模型推理调用。收据保存在 `.modelspage/custom-domains-live.json`、`public-api-filters-live.json`、`v1-publication-live.json`。

## 无变化重发回归与修复

文档与入口链接 PR #7 合并为 `a08a4dcdfbfe6f0eecc75d41cf05065b36801844`；[CI 40578939920](https://github.com/cogine-ai/modelspage/actions/runs/40578939920)、[自动发布40578939900](https://github.com/cogine-ai/modelspage/actions/runs/40578939900) 和 Pages 部署 `f40eb1e8-566b-4c24-b44e-4977ab291675` 均成功，网站排名 JSON 保持原 revision、时间与完整字节。但版本化发布意外生成了 sequence 2。

逐字段比较两个真实 catalog，11,916条事实和所有 metric profile 完全相同；唯一来源变化是停用的旧 `openrouter-weekly` 没有 snapshot 时，仅因存在 previous catalog 就换了一段 error 说明。这处诊断变化触发了正确保留来源审计字段的发布比较，制造了无数据变化的新版本。

修复仅在该来源已经 disabled 且没有新 snapshot 时保留既有说明；当前审核后的 usage 仍照常更新，其他状态转为 disabled 时仍记录原因。没有放宽发布比较、删除来源审计或改变 C/P/N 规则。回归先复现 initial build → previous 重建会发布 sequence 2，修复后返回 unchanged／sequence 1，并确认 manifest 内容和元数据不变、候选对象未上传。本项目完整209项测试／1395断言与类型检查通过。

已发布 sequence 2 保留为历史，不倒退发布序号。当前 revision 为 `9c8dd12a8c6b4edfd5a861044ccdc1e008afb8a9809d192d324b6d416a5e5332`，发布时间 `2026-10-27T20:32:18.000Z`，manifest SHA-256 `369d163684f35b10b22d3eae7a597e6cee61b822b55f3ebf3d150ad1128e615e`；catalog 36,050,111字节、SHA-256 `b82f971d64a13a6de4d622e6c3f5c3d45d42e19937c97bbc777a6e65211d6b81`。

[修复 PR #8](https://github.com/cogine-ai/modelspage/pull/8) 已合并为 `08f4f98cf7400cb334de1b2f589176ac550e6867`；[CI 40581264802](https://github.com/cogine-ai/modelspage/actions/runs/40581264802) 通过，[自动发布40581264646](https://github.com/cogine-ai/modelspage/actions/runs/40581264646) 的真实日志返回 `unchanged / sequence 2 / revision 9c8dd12a8c6b4edfd5a861044ccdc1e008afb8a9809d192d324b6d416a5e5332`。三个域名回读的 manifest SHA-256 仍为 `369d163684f35b10b22d3eae7a597e6cee61b822b55f3ebf3d150ad1128e615e`，排名 JSON SHA-256 仍为 `df384a4862505fad20d4b73610577a603c0760d6b318cbf9fa000a217f3aba45`；未制造新的资料时间或发布序号。

## 程序客户端的已知访问限制

三个正式域名及 `modelspage.pages.dev` 使用默认 `Python-urllib/3.12` User-Agent 重复返回403／error 1010；使用 `curl/8.7.1` 和 `Modelspage public-readback/1.0` 均返回200。因此，上述公开读取验收覆盖这些已验证客户端，不代表所有库的默认客户端都可访问。

[Cloudflare error 1010 官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)确认：Pages 自定义域名和 `pages.dev` 也经过 Cloudflare 管理区的 Browser Integrity Check；自有 zone 关闭或 skip 此检查不能覆盖该层。客户端应发送标识自身应用的描述性 User-Agent，无需伪装浏览器。Python urllib 的 manifest 请求示例见[运行手册](deployment.md#程序读取)。此次仅记录限制与客户端接入方法，未修改全局安全设置或部署架构。
