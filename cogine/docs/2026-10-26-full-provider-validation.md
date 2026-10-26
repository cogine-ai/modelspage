# CogineWork 全 Provider C/P/N 验证（2026-10-26）

**最新补验：** 已使用本项目补齐的专用变量重新遍历全部 39 项，最新目录、关联覆盖和全部问题见 [2026-10-27 全量补验](2026-10-27-full-keyed-provider-validation.md)。本页以下数字为历史快照。

**后续更新：**本页保留初轮交集试算的历史证据。用户随后确认 P 使用 60/30/10 固定权重累加并集，并取消连续七天齐全的门槛；当前报告已更新为 56 个独立模型、241 条 P 记录，见[并集规则与短窗口统计](2026-10-26-popularity-weighted-union.md)。初轮原报告留在本地忽略目录 `.modelspage/full-validation/report-before-weighted-union/`；下文的初轮 hash、19 条和验证统计均对应该历史输入与方法。

本轮遍历全部 39 个内置 Provider，按固定 CogineWork 源码尝试真实模型目录刷新，并将每个模型放入 C/P/N 诊断顺序。**范围遍历完成；全员认证刷新和上线准备尚未完成。** 生产 C 的 AA adapter、公共 canonical 得分投影和多来源 P 仍未接入；诊断输出不是可发布 bundle。

## 固定输入与本地结果

- CogineWork HEAD：`f06181cbc864bdc3938d45920a86a5724fdd1c48`。27 个读取的公开源码/随包资料文件与该 HEAD 相符；不执行应用、不读取用户设置、私有目录或 OAuth 账户资料。本轮只修改 Modelspage。
- models.dev 最新参考：`95efacf4b7e6e708a979c6a9d50a466b40835030`。原始 10,612 个 blob 与 Git tree 逐个核对，零差异；生产 pin/解析器仍为 `4f1231e6bf72d5fa66dc1163599eaaedb607faab`。
- 最新参考有 231 Provider、9,304 个模型文件身份、11,971 个已提取协议身份。9,260 条由固定解析器生成；44 条仅保留原始明确字段，其中 27 条新版 schema 不兼容、17 条为固定生成器跳过的 legacy alias。逐 Provider 精确模型 ID 集合全部核对。整体状态是 `partial`，不能称为全部 schema 通过。
- 验证时钟：`2026-10-26T14:13:42.921Z`。参考 JSON SHA-256：`98752746311afebcbf914ae2576f36a8ca43aa1136d6be5ec2cd9c97a2978f84`。
- 本地报告：`dist/full-validation/index.html`，完整 `report.json`、`models.csv`、`providers.csv`、`source-associations.csv`、`issues.csv` 和 `verification.json`。原始响应、hash、历史尝试与 last-good 位于忽略的 `.modelspage/full-validation/`。
- 这些结果仅本地保留，没有把认证响应、AA 原始得分或密钥提交到公共仓库。

## 真实覆盖结果

这里的“客户端上下文”指按固定源码重现的协议投影，包含受限或退役的内置定义，不等于安装版可见性或当前账户可用性。6 个 Provider 受默认 manager 限制，GitHub Models 已 retired；这些状态同样保留在完整 JSON/CSV 中，没有解除限制。

7 个目录刷新成功，共 1,161 个来源模型 ID；固定客户端协议投影接纳 1,100 条。连同 192 条明确标为旧资料的随包回退，共有 1,292 条客户端上下文记录。另补录 61 个客户端未接纳的实时来源 ID、48 个 catalog-only Provider 的最新上游资料，共 1,401 条诊断记录；来源补录不会扩大客户端可用成员。

| 指标 | 全部诊断记录 | 客户端上下文内 | 来源补录内 |
| --- | ---: | ---: | ---: |
| C：AA 主记录参考得分 | 515 | 487 | 28 |
| P：三来源共同窗口试算 | 19 | 16 | 3 |
| N：已发生的日精度日期 | 1,097 | 1,039 | 58 |

以上是 Provider × 请求模型 ID 的记录数，同一 canonical 在多个 Provider 会重复出现，不等于独立基础模型数。无数据记录仍保留在完整列表与确定总序中；兜底顺序不能解释为能力或热度排名。

12 个 Provider 返回需认证，Gemini 匿名请求 403，Kimi International 经有限重试仍有 TLS 网络错误；这 14 个未完成真实认证目录刷新。另有 14 个 catalog-only/不支持目录接口、3 个本地目录和 1 个 OAuth 账户目录，均明确标注未执行或不支持。API Key 不能为原本没有目录接口的 Provider 创建接口。

C/P/N 三列统计涵盖客户端与来源补录两部分，因而不能直接除以“客户端上下文”列。完整 JSON 同时提供 `client_c_known`、`client_p_trial_known`、`client_n_known`，用于只看客户端覆盖。

| Provider ID | API 刷新状态 | 客户端上下文 | 来源补录 | C 参考 | P 试算 | N 日精度 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `coginework-local` | not_run_local | 0 | 0 | 0 | 0 | 0 |
| `coginellm` | requires_auth | 1 | 0 | 0 | 0 | 0 |
| `ollama` | not_run_local | 0 | 0 | 0 | 0 | 0 |
| `lmstudio` | not_run_local | 0 | 0 | 0 | 0 | 0 |
| `ollama-cloud` | refreshed | 23 | 0 | 0 | 0 | 0 |
| `openrouter` | refreshed | 466 | 0 | 162 | 2 | 387 |
| `github-models` | not_supported | 2 | 0 | 0 | 0 | 0 |
| `modelscope` | refreshed | 37 | 0 | 0 | 0 | 0 |
| `dashscope` | requires_auth | 7 | 0 | 5 | 0 | 7 |
| `aliyun-codingplan` | not_supported | 10 | 0 | 1 | 0 | 10 |
| `aliyun-codingplan-intl` | not_supported | 10 | 0 | 1 | 0 | 10 |
| `aliyun-tokenplan` | not_supported | 16 | 15 | 16 | 1 | 30 |
| `aliyun-tokenplan-intl` | not_supported | 16 | 15 | 16 | 1 | 30 |
| `opencode` | refreshed | 85 | 0 | 67 | 4 | 83 |
| `opencode-go` | refreshed | 19 | 19 | 25 | 2 | 31 |
| `kilo` | refreshed | 400 | 0 | 160 | 2 | 394 |
| `openai` | requires_auth | 14 | 0 | 3 | 0 | 14 |
| `tokendance` | refreshed | 70 | 42 | 0 | 0 | 0 |
| `openai-response` | requires_auth | 14 | 0 | 3 | 0 | 14 |
| `openai-codex` | not_run_private_subscription | 0 | 0 | 0 | 0 | 0 |
| `azure-openai` | not_supported | 8 | 0 | 0 | 0 | 0 |
| `anthropic` | requires_auth | 2 | 0 | 1 | 0 | 2 |
| `gemini` | forbidden | 6 | 0 | 4 | 0 | 6 |
| `deepseek` | requires_auth | 3 | 0 | 2 | 0 | 3 |
| `kimi-cn` | requires_auth | 5 | 0 | 4 | 0 | 4 |
| `kimi-intl` | network_error | 5 | 0 | 4 | 0 | 4 |
| `kimi-codingplan` | not_supported | 4 | 0 | 0 | 0 | 0 |
| `minimax-cn` | not_supported | 8 | 0 | 0 | 0 | 0 |
| `minimax` | not_supported | 8 | 1 | 1 | 0 | 8 |
| `zhipu-cn` | requires_auth | 9 | 0 | 9 | 2 | 9 |
| `zhipu-cn-codingplan` | not_supported | 2 | 2 | 4 | 1 | 4 |
| `zhipu-intl` | requires_auth | 9 | 0 | 9 | 2 | 9 |
| `zhipu-intl-codingplan` | not_supported | 2 | 5 | 7 | 1 | 7 |
| `siliconflow-cn` | requires_auth | 0 | 0 | 0 | 0 | 0 |
| `siliconflow-intl` | requires_auth | 0 | 0 | 0 | 0 | 0 |
| `volcengine-cn` | requires_auth | 16 | 0 | 1 | 0 | 11 |
| `volcengine-cn-codingplan` | not_supported | 9 | 2 | 7 | 1 | 10 |
| `mimo-tokenplan` | not_supported | 2 | 6 | 3 | 0 | 8 |
| `agnes` | not_supported | 4 | 2 | 0 | 0 | 2 |

## C：关联与评测配置

AA 认证接口实际返回 709 条、698 条数值得分，Intelligence Index 4.3，4 页完整。当前密钥使用免费接口，没有 `openrouter_api_id` / Hugging Face bridge。先保留精确 slug；只进行标点大小写规范化，并显式支持 Claude family/version 顺序。仅在名称末尾有明确配置括号时，固定配置 suffix 才生成离线候选；保留日期、版本、preview、vision、instruct、量化和容量语义。

本报告 342 条 AA 来源记录关联到已服务的 canonical，其余 367 条保持未关联（包含没有 Provider 服务记录的 canonical）。不会为了提高覆盖率吞掉版本或把近似名字当事实。

同一 canonical 可有多个 effort/推理配置。本轮 249 条 Provider 模型记录有多个 AA 配置候选。诊断 C 使用唯一 base-slug 主记录作参考，并在 JSON/CSV/页面展开中保存所有配置及原始名称；不取最高分，也不宣称它是统一 effort 或当前 Provider 的运行配置。这是待定的生产选择政策。来源明确的可比较方法应沿用 AA profile；现生产合同把不同被测模型快照/配置强绑为单值的问题仍需修正。

## P：共同窗口试算

实际采集并逐条保留 3,017 条来源记录：

| 来源 | 记录 | 口径及缺口 |
| --- | ---: | --- |
| OpenRouter | 357 | 10/19–25 七个完整 UTC 日，每日 top 50 + Other，`period=day&modality=text`；保留原生日总分母。API Key 用于公共 dataset，不读取账户用量 |
| Vercel AI Gateway | 1,355 | 日 requests/tokens/spend 份额；17 个具体模型名全部精确命中官方模型目录名称。没有平台每日 token 总量，因此不能还原整周量加权份额；无全局 `data_as_of` |
| OpenCode Go/Free | 596 | 原生 pastDay/pastWeek 榜单及日 token 图。日图 56 天、9 个具体模型 + Other，原生每日总量独立保留；不是 Zen/Go/Free 三个独立样本 |
| AA | 709 | 只用于 C，不计为热度来源 |

试算窗口是 2026-10-19 至 2026-10-25，排除尚未结束的当前 UTC 日。每个平台先计算模型**每日 token 份额均值**，再三平台各 1/3。它不是整周 token 量份额、真实请求次数或去重后的市场占有率。某模型在任一来源缺一天即为 unknown，不将未进 top 榜填零，也不逐模型重分配权重。因此只有 19 条记录可试算；不能把此结果称为广泛 P 覆盖。

每条模型记录保存 `p_source_scores`、`p_missing_source_days` 和原生排名证据。剩余政策包括：调用次数优先还是 token 热度、平台权重、部分覆盖处理、是否采纳此均值口径，以及主要模型名单和上线覆盖标准。没有擅自将试算写入生产规则。

来源用途逐项留在 snapshot：Vercel 与 OpenRouter dataset 的 CC BY 4.0 证据保留；AA 的公开 JSON 再分发、OpenCode 的公开再分发条件尚未落实。本地认证采集成功不等于自动获得公共发布授权。

## N 与身份缺口

N 直接信任固定解析器解析出的最新 models.dev `release_date`，不再要求本地逐条人工核验。日精度 1,097 条可排序，另 8 条只有月精度而未被补造日期。138 条有明确 Provider 路由但最新上游没有 exact 模型 ID；158 条缺少 CogineWork 明确声明的 models.dev Provider 路由；246 条命中上游模型记录却无 `base_model`。这些身份问题会影响 C/P 关联，不能误称 AA/日期原始源仅有少量记录。

Go 38→19、TokenDance 112→70 是当前客户端协议投影；源目录中被排除的 61 个 ID 已单独做 C/P/N 诊断。Zen 4 个新 ID 缺官方协议注册记录，保留目录成员但协议 unknown。没有修改 CogineWork 协议规则、执行 ID、路由、选模或账户资格。

## 过程问题与修正

| 发现 | 最终处理和复验 |
| --- | --- |
| 初轮多处 timeout/TLS 失败 | 有限重试后恢复部分；Kimi Intl 仍失败。初轮六处瞬态问题摘要、当前状态和历史均保留，未重造未知时间戳 |
| 旧固定解析器遇到新 `media_input` 字段即整体失败 | 隔离数据 view 排除不兼容行，再复用固定生成器；27 行原文与诊断保留，raw_partial 只取原始明确字段 |
| ID 自身含 `/models/` 时截断；枚举漏 symlink alias | 改固定前缀 slice，枚举跟随上游明确 symlink；18 个 alias 补齐。最终 9,304 个身份逐 Provider 集合相等，重复 ID 拒绝 |
| 初版只报告客户端模型，漏来源模型与 catalog-only 新资料 | 补录 61 +48 条，独立 basis 和客户端成员标志；核对实时 1,161 与客户端 1,100 的集合，未扩大客户端列表 |
| 初版全局模式按 Provider 分组、文件写入与 weights 类型错误 | 改全局指标总序、原子输出及正确的 canonical 元数据；类型检查、全序/成员保持回归通过 |
| AA 主 slug 唯一却隐藏多个 effort | 保留固定后缀候选及全部配置；主记录仅标参考试算，不挑最高分 |
| OR 最初用整周桶；日分母可能被重复累加 | 改真实七天日桶，原周快照留在历史；原生每日总量仅使用一次，含 Other 的分母回归通过 |
| partial 来源可能参与计分；来源退出窗口无原因 | partial 只保留观察不计 known，明确窗口缺失问题；当前三来源均完整并参与 |
| curl 默认配置、响应回显密钥、固定文件重跑覆盖风险 | `curl -q`、认证头 stdin、响应先内存检查再落盘、内容寻址 raw、历史和 last-good；明文/Unicode 回显与失败保留回归通过 |
| 分页标记、总数或输入 hash 可能不完整/漂移 | 补齐分页结束/总数校验，固定首次读取 bytes，拒绝跨源分页；单 Provider 配置错误隔离 |
| 初稿报告使用未来固定时钟 | 最终重新以实际执行时间生成；该时钟只用于诊断与 N 判断，不伪装来源更新时间 |

刷新采集专项证据另见 [validation-refresh-review.md](validation-refresh-review.md)。每一条模型缺口及来源限制均在本地 `issues.csv` / `report.json`，汇总如下：

| 问题代码 | 记录数 |
| --- | ---: |
| `aa_score_missing_for_canonical` | 344 |
| `anonymous_membership_is_not_account_qualification` | 1 |
| `client_excludes_unknown_registry_contract` | 7 |
| `client_excludes_unsupported_protocol` | 42 |
| `client_excludes_unsupported_registry_transport` | 12 |
| `forbidden` | 1 |
| `latest_upstream_schema_incompatible` | 27 |
| `model_missing_from_latest_upstream_provider` | 138 |
| `multiple_aa_configurations_need_policy` | 249 |
| `network_error` | 1 |
| `no_declared_modelsdev_provider_route` | 158 |
| `non_day_date_excluded_by_current_n_policy` | 8 |
| `not_run_local` | 3 |
| `not_run_private_subscription` | 1 |
| `not_supported` | 14 |
| `p_missing_common_source_evidence` | 840 |
| `popularity_policy_pending` | 1 |
| `production_cpn_pipeline_incomplete` | 1 |
| `provider_refresh_unavailable` | 32 |
| `refresh_process_observations` | 1 |
| `requires_auth` | 12 |
| `source_limitation` | 8 |
| `unknown_registry_contract` | 4 |
| `upstream_record_has_no_base_model` | 246 |

## 密钥文件与复跑

专用文件是仓库根目录 `.env.validation`，0600，Git ignored；空模板在 [`../config/validation.env.example`](../config/validation.env.example)。22 个变量涵盖 AA、OpenRouter 和来源源码声明的 Provider 验证接口。只填拥有的专用 key；没有值的项明确保留缺口。OpenAI Response 可明确复用 OpenAI 验证 key；不跨地区/套餐自动复用。当前 AA 和 OR 已实测认证成功，其余需要认证的项仍待补充。

在仓库根目录使用固定 Bun 1.4.4：

```sh
python3 -B cogine/scripts/validation/inventory.py --coginework-root /path/to/CogineWork
bun --env-file .env.validation cogine/scripts/validation/refresh.ts
bun --env-file .env.validation cogine/scripts/validation/rank-sources.ts
bun cogine/scripts/validation/report.ts --now 2026-10-26T14:13:42.921Z
```

已有输入无需重复联网。增量认证可用刷新脚本 `--only openai,openai-response`，来源脚本 `--only artificial-analysis,openrouter`；未选项保持原快照。新一轮实际时钟可省略 `--now`；复现旧时钟不意味着重新采集旧历史。

最新上游是单独的参考数据，不改变生产 pin：用远端 HEAD 发现不可变 SHA，`git fetch --no-tags <upstream-url> <SHA>` 后只 archive `models/`、`providers/` 到忽略目录，再运行 `bun cogine/scripts/validation/upstream-reference.ts --commit <SHA>`。该脚本对 partial 返回 exit 2，保留可消费的逐条诊断；它没有升级生产解析器或执行最新下载代码。

## 已执行验证与剩余验收

固定 Bun 1.4.4：类型检查、JSON schema 一致性通过；Cogine 全套 108 pass、0 fail、621 assertions。新增刷新、来源安全与报告测试共 20 项，覆盖缺失不为零、日窗口、配置语义、AA 方法不混排、分母、全局传递总序及来源补录不授予成员。

最终输出的输入 hash、29 个原始响应 hash、39 Provider 全集、7 份完整来源 ID 集合、7 份客户端集合及三项全局序列核对通过。对本任务 227 个产物/暂存文件（含全部 13 个待提交文件）进行原文与 JSON 解码后密钥扫描，0 命中。独立重算 C/P/N 与全局顺序一致。报告记录 Bun 版本、生成时 Git HEAD/dirty 状态及七个实现文件的 SHA-256，以保留尚未提交时生成报告的实际代码输入。报告 SHA-256：`484924c672e78fea4fabb8082c5b4a055da3b1659cf8ae12596caff6b9e2b2fb`，收据在 `dist/full-validation/verification.json`。

真实浏览器已检查 Provider 切换、C 排序、客户端过滤（Go 38→19）、渲染及控制台无错误；没有运行安装版客户端工作流、账户资格或模型推理。没有上传生产数据、切换 manifest 或配置 DNS；生产开关仍关闭，DNS 记录按用户要求在正式部署准备完成后统一交付。
