# 2026-10-27 全量 Provider 目录补验

本轮覆盖固定 CogineWork 内置 inventory 的全部 39 个 Provider。18 个目录刷新成功，其中 13 个请求携带对应专用验证 key，5 个使用匿名公开目录；另有 2 个匿名 HTTP 401、1 个 HTTP 前网络断连、14 个源码不支持通用远端刷新、3 个本地目录和 1 个订阅 OAuth 目录未执行。

共取得 **2,065 条 Provider/model 原始目录 ID、1,989 条远端发现投影**。这是按 Provider 分别统计的记录数，同一基础模型可出现在多个 Provider。远端发现投影不是完整客户端上下文，也不证明模型推理或账户使用资格。

## 固定输入与时间

- CogineWork 来源 HEAD：`f06181cbc864bdc3938d45920a86a5724fdd1c48`。
- Inventory SHA-256：`96c4deec45f9063ac4e56d1d06f1ab009ad08dfadcc6f354db56b6bce054a3c0`。
- 运行时：仓库固定 Bun `1.4.4`。
- 全量首轮：台北时间 2026-10-27 **04:17:48–04:18:14**，对应 UTC 2026-10-26 20:17:48–20:18:14。
- Kimi 国际站的一次 curl 重试：台北时间 **04:18:35–04:18:39**。
- 同地址 Bun 客户端单次对照：台北时间 **04:23:58–04:24:02**。

采集只使用源码声明的目录 GET 和明确的专用环境变量。没有执行推理、读取用户私有模型配置、本地服务或 OAuth 目录，也没有切换生产发布。采集时间是请求观察时间，不能代替来源 `data_as_of` 或模型发布日期。

全量命令：

```sh
.modelspage/tools/bun-1.4.4-npm/package/bin/bun --env-file .env.validation \
  cogine/scripts/validation/refresh.ts
```

随后仅对 `kimi-intl` 使用同一脚本及 `--only kimi-intl` 做了一次有限重试。最后的 index 汇总保留所有 39 个 Provider；其 `started_at` 属于这次选定 Provider 的重试，不代表其他 Provider 又在该时间请求了一遍。

## 全量结果

| 状态 | Provider 数 | 本轮含义 |
| --- | ---: | --- |
| `refreshed` | 18 | 目录及所需元数据获取、解析完成 |
| `requires_auth` | 2 | 缺少对应专用 key，匿名请求返回 401 |
| `network_error` | 1 | 配置了专用 key，但在 HTTP 响应前断连 |
| `not_supported` | 14 | 固定源码没有支持的通用远端刷新合同 |
| `not_run_local` | 3 | 本地目录未读取、未请求 |
| `not_run_private_subscription` | 1 | Codex 订阅 OAuth 目录未读取、未请求 |
| 合计 | **39** | Inventory 与 index 的 ID 集合完全一致，无缺项或重复 |

成功目录如下。表内“带 key”只表示请求携带对应专用 key 且返回 HTTP 200；公开接口可能忽略认证，因此不能仅由此宣布凭据有效、模型可推理或账户具备额度。

| Provider ID | 请求方式 | 原始 listed ID | 远端发现投影 | 目录及元数据 GET 数 |
| --- | --- | ---: | ---: | ---: |
| `coginellm` | 带 key | 128 | 127 | 1 |
| `ollama-cloud` | 带 key | 23 | 23 | 1 |
| `openrouter` | 带 key | 468 | 468 | 1 |
| `modelscope` | 匿名 | 37 | 37 | 1 |
| `dashscope` | 带 key | 180 | 180 | 1 |
| `opencode` | 匿名 | 84 | 84 | 2 |
| `opencode-go` | 匿名 | 38 | 19 | 2 |
| `kilo` | 匿名 | 401 | 401 | 1 |
| `openai` | 带 key | 134 | 134 | 1 |
| `tokendance` | 匿名 | 112 | 70 | 1 |
| `openai-response` | 带独立 key | 134 | 134 | 1 |
| `gemini` | 带 key | 60 | 46 | 2 |
| `deepseek` | 带 key | 2 | 2 | 1 |
| `kimi-cn` | 带 key | 6 | 6 | 1 |
| `zhipu-cn` | 带 key | 11 | 11 | 1 |
| `zhipu-intl` | 带 key | 11 | 11 | 1 |
| `siliconflow-cn` | 带 key | 98 | 98 | 1 |
| `volcengine-cn` | 带 key | 138 | 138 | 1 |
| 合计 | **13 带 key／5 匿名** | **2,065** | **1,989** | **21** |

ModelScope 虽然本轮匿名目录成功，固定客户端策略仍声明认证发现；没有据此验证账户可用模型集合。

## 仍未取得目录的三个接口

| Provider | 本轮结果 | 已执行动作与结论 |
| --- | --- | --- |
| `anthropic` | 匿名 HTTP 401 | 对应专用 key 未配置，没有用其他 Provider 的 key 替代；目录未知 |
| `siliconflow-intl` | 匿名 HTTP 401 | 对应国际站专用 key 未配置，没有复用中国站 key；目录未知 |
| `kimi-intl` | HTTP 前断连 | 专用 key 已准备；首轮及一次 curl 重试均为 curl 35／`SSL_ERROR_SYSCALL`，没有 HTTP 状态或响应正文 |

Kimi 国际站之后仅对相同 `https://api.moonshot.ai/v1/models` 做了一次 Bun `fetch` 对照，保留默认 TLS 校验、禁止自动跟随重定向，没有重设代理、跳转其他地区或使用 insecure 选项。该请求同样在 HTTP 前以 `ECONNRESET` 结束，0 字节正文。两种客户端都没有取得可评估认证结果，不能把问题归因于 key，也不能报告目录为零模型；停止继续重试。

## 源码声明不支持或未运行的全部 Provider

本轮 `not_supported` 的 14 项均有单独结果和源码原因；没有通过静态模型后备冒充最新刷新成功：

`github-models`、`aliyun-codingplan`、`aliyun-codingplan-intl`、`aliyun-tokenplan`、`aliyun-tokenplan-intl`、`azure-openai`、`kimi-codingplan`、`minimax-cn`、`minimax`、`zhipu-cn-codingplan`、`zhipu-intl-codingplan`、`volcengine-cn-codingplan`、`mimo-tokenplan`、`agnes`。

未运行的本地目录为 `coginework-local`、`ollama`、`lmstudio`；未运行的私有订阅目录为 `openai-codex`。这些状态不说明厂商没有模型或没有其他公开产品，只说明本轮固定客户端合同及授权范围内没有执行相应目录采集。

## 原始目录与客户端投影的差异

这些差异来自固定客户端的发现规则，不是 C/P/N 排序层删掉来源记录。原始精确 ID 继续保存在 `listed_model_ids`，未知不是零，也没有修改执行模型 ID。

- **CogineLLM：128 → 127。** 远端发现函数故意排除重复的 `cogine/free`；客户端同时保留原生随包 `cogine/free`，因此本次无用户额外配置的完整上下文应为 **127 个发现模型＋1 个原生模型＝128**。不能只取发现列表，也不能将这条原生模型错标为客户端不支持。原生模型的元数据与实时目录成员证据分别保留。
- **Gemini：60 → 46。** 实际读取两页，分别 50 和 10 条；14 条不声明 `generateContent`，按固定 SDK 发现规则不进入生成模型投影。所有页均为 HTTP 200，没有留下未消费的下一页标记。
- **TokenDance：112 → 70。** 42 条来源记录的 `supported_protocols` 不含客户端所需的 `openai:chat-completions`；原始 112 个 ID 仍保留。没有把目录 `created` 当作模型发布日期。
- **OpenCode Go：38 → 19。** 7 条缺少精确 registry 合同；另外 12 条被当前只接纳文本 Chat Completions 的客户端投影排除，其中来源协议为 Responses 的 5 条、Anthropic Messages 的 6 条及其他未支持协议的 1 条。缺少合同的 ID 是 `glm-5.1`、`grok-4.6`、`omen-alpha`、`kimi-k2.6`、`minimax-m2.5`、`qwen3.6-plus`、`qwen3.7-max`。
- **OpenCode Zen：84 → 84。** 4 个实时成员缺少 registry 合同：`jev-1.13-free`、`test`、`jev-1.13`、`claude-opus-5-5-backup`。成员保留，协议为 unknown，不借随包数据制造已支持能力。

OpenRouter 本轮明确报告 `total_count=468`、`links.next=null`，与取得的 468 个 ID 一致；DashScope 明确报告 `has_more=false`。没有分页或完整性标志的来源按各自固定完整数组合同记录，不额外制造来源总量或账户资格。

## CogineLLM `owned_by` 离线补全

本轮保存的 128 行原始 CogineLLM 响应带有 `owned_by`。规范化现在只保留来源实际给出的字符串，不设默认值、不改大小写或空白、不猜厂商，也不把该字段当作执行跳转指令。

从已保存的最近一次响应离线补齐了当前结果及 last-good 的 `models`／`live_membership_models`，各 127 条发现记录均保留 `owned_by=openrouter`。没有为了补字段再次请求外网；没有改写原始响应、模型 ID、顺序、固定输入／源码 revision 或 `attempted_at`、`completed_at`、`retrieved_at`。补全前后的 JSON 均入 immutable history。

该响应 SHA-256 为 `32d6c85e4329bd0d43ede3e21843c2d2e75fbf07e630220fabf06dd2e900afc1`。字段保留本身不自动授权跨 Provider 继承 C/P/N；身份关联和排名结果由对应 adapter 与后续重算单独报告。

## 历史、完整性及秘密边界复核

独立复核直接读取 inventory、index 和全部 39 份当前结果，确认：

- Provider ID 集合完全一致且各自唯一，全部 source revision 和 inventory hash 一致。
- index 的状态、数量、issue 数与每份结果一致；每个投影 ID 都存在于该 Provider 的原始 listed ID 中。
- 18 份成功结果均完整、所有相关 GET 均为 HTTP 200，且其 last-good 与当前结果一致。
- 23 个当前有正文的响应对象 SHA-256 全部匹配；上轮 39 份 current 及既有 last-good 已保留在 history，上轮 22 个原始响应对象字节未变。
- 失败、部分结果或网络诊断没有被记为 PASS，也没有清空已有有效事实；随包后备仍明确标为非最新资料。

现有 14 个 Provider 专用 key 变量全部用于对应目录请求；OpenAI Response 使用自己的独立变量，没有借用 OpenAI 的 key。Kimi 国际站仅能证明专用认证头已准备，不能证明服务端收到或接受。另一个非空 AA key 属于排名来源采集，不由本次目录刷新脚本消费。没有跨中国站／国际站／套餐复用 key。

认证头只经 stdin 或 Bun 请求头内存传递，不进入命令参数、日志、fixture 或报告；curl 关闭本机默认配置，响应头仅在内存按非秘密白名单处理，不保存 Set-Cookie。正文在写盘前检查明文及 JSON 解码后的密钥回显。对本地 refresh、raw、history 及诊断文件的 204 份 JSON，以当时 15 个非空验证变量做原文／JSON 解码检查，发现的凭据内容匹配数为 **0**；检查不输出凭据值。

定向回归：`bun test cogine/test/validation-refresh.test.ts`，**12 项通过、55 个断言**；本次规范化改动后的类型检查通过。这不等于安装版客户端工作流或真实模型推理验收。

## 本地证据索引

以下资料位于忽略目录 `.modelspage/full-validation/`，不作为公共分发包发布：

| 路径 | 证据 |
| --- | --- |
| `inputs/coginework-providers.json` | 固定 39 项 Provider inventory 及来源 |
| `refresh/index.json`、`refresh/<provider-id>.json` | 本轮全部状态、精确 ID、请求、问题及来源 hash |
| `refresh/raw/`、`refresh/history/`、`refresh/*.last-good.json` | 内容寻址来源字节、尝试历史和最后成功结果 |
| `refresh/full-keyed-run-verification.json` | 当前 raw／上轮 raw／历史保留核对 |
| `refresh/full-keyed-independent-audit.json` | 独立核对 39 项集合、13 带 key 成功／5 匿名成功及汇总一致性 |
| `refresh/full-keyed-run-source-completeness.json` | 实际来源分页、完整性及总量字段 |
| `refresh/full-keyed-run-issues.json` | 本轮逐 Provider、逐模型问题清单 |
| `refresh/kimi-intl-bun-transport-diagnostic.json` | 单次默认 TLS 的 Bun 客户端对照失败 |
| `refresh/coginellm-owned-by-replay.json` | 离线字段补全及 ID／事实时间不变断言 |

## 排名重算结果

本轮最终诊断有 **2,221 条 Provider × 请求模型 ID 记录**：2,098 条客户端上下文、123 条来源补录。客户端由 1,989 条远端发现投影、1 条原生 CogineLLM 模型及 108 条明确非最新的随包回退组成；来源补录为 75 条实时协议未接纳记录与 48 条 catalog-only 上游参考，不扩大客户端成员。

| 指标 | 全部诊断记录 | 客户端上下文 |
| --- | ---: | ---: |
| C：AA 主记录参考 | 660 | 632 |
| P：60/30/10 观测并集 | 329 | 303 |
| N：有效日精度日期 | 1,488 | 1,420 |

同一 canonical 在多个 Provider 会重复出现，以上不是独立模型数。P 独立模型按 1/2/3/7 日窗口分别为 **45 / 47 / 49 / 56**；7 日不要求连续覆盖。当前客户端 P 兜底为 303 条有 P、386 条按 C、736 条按 N、673 条稳定默认次序，合计仍是 2,098 条，未知值未被改写。

最新 models.dev 参考固定为 `34c9b5ba354d074cc369cbf6be03960978760bd4`，生产/parser pin 仍为 `4f1231e6bf72d5fa66dc1163599eaaedb607faab`。原始 10,610 个 blob 与 Git tree 内容逐个核对一致；231 Provider、9,301 个 exact 模型身份全部保留，9,020 条 generator、281 条 raw_partial，266 条 schema/语义诊断保留，状态仍是 partial。N 专用投影取得 229 条固定 parser 日期结果，补回 188 条原先缺失的上游日期，既有日期无变化；本报告 106 行引用该投影，相比未投影时有效 N 净增 86 行。参考 JSON SHA-256 为 `ad28e607add06ce1690dff45533470cb19e470053f9e6928ce362d625794d1c9`。

当前重算范围及逐 Provider 覆盖在本节后续表格。原始目录、客户端协议投影、来源补录和随包回退各自保留 basis；所有模型都进入确定总序，未知事实不变成零或兜底指标。

### 身份与来源的修正

- **CogineLLM**：校验最近原始响应 hash，再使用该 exact ID 行明确的 `owned_by=openrouter`，在上游 OpenRouter 命名空间逐字查找；127 个普通模型全部命中，111 个具备 canonical。`cogine/free` 是动态网关，继续无具体模型 C/P/N；通用身份桥也不能覆盖此例外。
- **Ollama Cloud**：最新上游已经有同名 Provider，公开 API base 与 CW 相同。23 个 exact ID 全部命中，不删除 `:cloud`、日期或量化后缀。
- **ModelScope**：37 张公开模型卡中 36 个 HTTP 200、1 个 404（`early-access/EA-29B-A4B`）。落实 3 条官方 self 模型引用：DeepSeek V4 Pro、MiniMax M1 80k、Step 5 Preview。来源原文、hash、片段、地区/API base 和字段范围均保留；仅对接 C/P 来源，不将其他 Provider 的日期复制为 N。Step 3.5 的同一 HF URL 在上游对应两个 canonical，保持歧义；1017 卡引用旧版作比较，不能合并版本。
- **TokenDance**：50 个 global exact ID 单候选、4 个多候选、58 个无候选只是离线研究，未因名字相同就授权事实继承。当前没有来源命名空间证据，C/P/N 缺口如实保留。
- **OpenRouter**：保留旧目录 690 条与新目录 696 条的 native ID/canonical_slug 桥并集，避免日统计中的历史 slug 因当前目录刷新而消失；857 个 alias key 当前无多 canonical 冲突。Vercel 最新目录 482 条，17 个用量名字均精确命中其官方目录。

新增语义防护及回归：官方引用的 HF URL 在当前上游出现多 canonical 时，原桥改为显式 ambiguous，不再计分；动态 `cogine/free` 不接受外部通用桥。另对 OpenRouter 同一 API ID 在跨代目录改指其他 canonical_slug 的情况，不再用当前 API ID 解释历史统计；若各旧/新 slug 均可独立解析为同一 canonical 才允许作为改名，否则显式 ambiguous。三项边界由代码审查发现，当前真实 3 桥及两代 OR 目录均未触发，没有将条件性风险描述为已经发生的数据错误。

### 排名来源与边界

4 个排名来源均成功取得完整响应。AA 715 条记录、704 条数值得分，Intelligence Index 4.3；较上一轮新增 6 个 GPT-6.1 Terra 配置。OpenRouter 357、Vercel 1,355、OpenCode Go/Free 596 条；七个完整 UTC 日仍为 2026-10-19 至 25，台北日期跨日不提前纳入尚未结束的 UTC 10/26。Vercel 没有全局 data_as_of，未用抓取时间代替；OpenCode pastWeek 与日图分别保留，没有重复作为两个平台权重。

C 使用唯一 base-slug 主记录作诊断参考，保留所有 effort 配置，未取最大值，也未声称 Provider 默认运行配置与 AA 相同。P 按已确认 60/30/10 固定权重累加任一来源/任一天的观测份额，不要求连续七日，不逐模型重分配缺失权重；P 未知时按 C、N、既定稳定次序兜底，原 P 事实仍为 unknown。

原始 AA/认证响应及这些诊断输出没有提交到公共仓库。OR dataset 与 Vercel 的 CC BY 4.0 证据保留；AA、OpenCode 的公共 JSON 再分发条件尚未落实。生产 AA adapter、canonical 得分投影、多来源 P 每日生产管道尚未完成；本轮采集是专用验证重跑，不等于生产 C/P 已每日更新。未达到上线条件，生产开关保持关闭。

### 本轮额外过程问题

- 新上游两个 Lyria Lab 的 audio/v1 语义错误曾令整个固定生成器失败。已仅隔离不兼容 Lab、其明确直接引用和失败 Provider 记录，避免单点拖垮其他模型的日期解析；原 archive 和全部 exact ID 均保留。
- 新 tools 元数据与固定 parser 的旧 schema 不兼容，不应阻断无关日期。日期专用临时投影仅移除已诊断的不兼容可选 tools 容器，固定 parser 仍负责 release_date、base_model 与 omit；只消费日期，不把删后的工具能力当真值，完整原始字段和诊断保留。
- 辅助公开目录抓取遇到一次 Python TLS EOF，改用一次系统 curl 取得完整响应；失败证据仍在历史，没有冒充主来源失败或抹除尝试。
- 独立 Python 复算首次将来源原生字符串分母当数字，出现类型错误；按来源数值转换后复算通过，生产计算未因此改变。
- 本地浏览器旧 tab 已不属于当前会话，重新绑定失败且当前标签为空；新建本地报告标签继续展示检查，未将失败绑定当通过证据。

最新字段来源、投影范围、全部问题分类及每条记录见本地 `report.json`、`issues.csv`；历史报告已归档到 `.modelspage/full-validation/report-history/`。

### 全部 Provider 的客户端排名覆盖

本表的 C/P/N 列仅统计客户端上下文，避免将来源补录覆盖除以客户端数量。API 刷新失败或不支持的行仍可引用已标明旧资料的随包记录；不能将该行 C/P/N 解读为最新目录验收。

| Provider ID | 刷新状态 | listed | 客户端 | 来源补录 | C | P | N |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `coginework-local` | not_run_local | 0 | 0 | 0 | 0 | 0 | 0 |
| `coginellm` | refreshed | 128 | 128 | 0 | 78 | 48 | 127 |
| `ollama` | not_run_local | 0 | 0 | 0 | 0 | 0 | 0 |
| `lmstudio` | not_run_local | 0 | 0 | 0 | 0 | 0 | 0 |
| `ollama-cloud` | refreshed | 23 | 23 | 0 | 15 | 13 | 22 |
| `openrouter` | refreshed | 468 | 468 | 0 | 163 | 62 | 386 |
| `github-models` | not_supported | 0 | 2 | 0 | 0 | 0 | 0 |
| `modelscope` | refreshed | 37 | 37 | 0 | 2 | 2 | 0 |
| `dashscope` | refreshed | 180 | 180 | 0 | 12 | 10 | 45 |
| `aliyun-codingplan` | not_supported | 0 | 10 | 0 | 1 | 0 | 10 |
| `aliyun-codingplan-intl` | not_supported | 0 | 10 | 0 | 1 | 0 | 10 |
| `aliyun-tokenplan` | not_supported | 0 | 16 | 15 | 13 | 4 | 16 |
| `aliyun-tokenplan-intl` | not_supported | 0 | 16 | 15 | 13 | 4 | 16 |
| `opencode` | refreshed | 84 | 84 | 0 | 67 | 34 | 82 |
| `opencode-go` | refreshed | 38 | 19 | 19 | 14 | 15 | 19 |
| `kilo` | refreshed | 401 | 401 | 0 | 161 | 60 | 393 |
| `openai` | refreshed | 134 | 134 | 0 | 9 | 7 | 72 |
| `tokendance` | refreshed | 112 | 70 | 42 | 0 | 0 | 0 |
| `openai-response` | refreshed | 134 | 134 | 0 | 9 | 7 | 72 |
| `openai-codex` | not_run_private_subscription | 0 | 0 | 0 | 0 | 0 | 0 |
| `azure-openai` | not_supported | 0 | 8 | 0 | 0 | 0 | 0 |
| `anthropic` | requires_auth | 0 | 2 | 0 | 1 | 0 | 2 |
| `gemini` | refreshed | 60 | 46 | 14 | 8 | 4 | 39 |
| `deepseek` | refreshed | 2 | 2 | 0 | 1 | 2 | 2 |
| `kimi-cn` | refreshed | 6 | 6 | 0 | 6 | 3 | 6 |
| `kimi-intl` | network_error | 0 | 5 | 0 | 4 | 1 | 4 |
| `kimi-codingplan` | not_supported | 0 | 4 | 0 | 0 | 0 | 0 |
| `minimax-cn` | not_supported | 0 | 8 | 0 | 0 | 0 | 0 |
| `minimax` | not_supported | 0 | 8 | 1 | 0 | 0 | 7 |
| `zhipu-cn` | refreshed | 11 | 11 | 0 | 11 | 4 | 11 |
| `zhipu-cn-codingplan` | not_supported | 0 | 2 | 2 | 2 | 2 | 2 |
| `zhipu-intl` | refreshed | 11 | 11 | 0 | 11 | 4 | 11 |
| `zhipu-intl-codingplan` | not_supported | 0 | 2 | 5 | 2 | 2 | 2 |
| `siliconflow-cn` | refreshed | 98 | 98 | 0 | 19 | 5 | 38 |
| `siliconflow-intl` | requires_auth | 0 | 0 | 0 | 0 | 0 | 0 |
| `volcengine-cn` | refreshed | 138 | 138 | 0 | 2 | 4 | 16 |
| `volcengine-cn-codingplan` | not_supported | 0 | 9 | 2 | 5 | 4 | 8 |
| `mimo-tokenplan` | not_supported | 0 | 2 | 6 | 2 | 2 | 2 |
| `agnes` | not_supported | 0 | 4 | 2 | 0 | 0 | 0 |

### 全部问题分类

分类条数是问题记录数，允许同一个模型有多个问题；具体 Provider/模型/来源/原始细节在 issues.csv。

| code | 条数 |
| --- | ---: |
| `aa_score_missing_for_canonical` | 486 |
| `anonymous_membership_is_not_account_qualification` | 1 |
| `client_excludes_non_generate_content` | 14 |
| `client_excludes_unknown_registry_contract` | 7 |
| `client_excludes_unsupported_protocol` | 42 |
| `client_excludes_unsupported_registry_transport` | 12 |
| `client_keeps_packaged_free_identity` | 1 |
| `dynamic_route_has_no_concrete_model_facts` | 1 |
| `latest_upstream_schema_incompatible` | 266 |
| `model_missing_from_latest_upstream_provider` | 582 |
| `multiple_aa_configurations_need_policy` | 338 |
| `network_error` | 1 |
| `no_declared_modelsdev_provider_route` | 134 |
| `non_day_date_excluded_by_current_n_policy` | 9 |
| `not_run_local` | 3 |
| `not_run_private_subscription` | 1 |
| `not_supported` | 14 |
| `p_no_observed_source_evidence` | 817 |
| `production_cpn_pipeline_incomplete` | 1 |
| `provider_refresh_unavailable` | 21 |
| `refresh_process_observations` | 1 |
| `requires_auth` | 2 |
| `source_limitation` | 8 |
| `unknown_registry_contract` | 4 |
| `upstream_date_missing` | 7 |
| `upstream_record_has_no_base_model` | 361 |

### 最终复核

Bun 1.4.4 下 **131 pass、0 fail、771 assertions**（19 个测试文件），类型检查和 JSON schema 一致性通过。使用仓库忽略目录作为测试 TMPDIR，原默认超时和断言不变；该本机临时目录性能问题的旧失败保留在历史记录。

独立 Python 从各来源每日条目及原生日总量重建全部 P，逐条核对 AA 记录值与 canonical、N exact Provider 来源、全部 39 个 Provider/live ID 集合、2,221 条诊断记录及每个 Provider/全局 C/P/N 总序；实现/evidence hash 和 23 个当前原始正文 hash 匹配。收据在 `dist/full-validation/verification.json`，报告保留生成时 HEAD/dirty 状态及 11 个实现输入 SHA-256。首次字符串分母类型错误已记录并修正后通过。

当前本地 HTML、全部模型/问题 CSV、来源关联 CSV、完整 JSON 和 1/2/3/7 日覆盖已更新；没有把原始认证响应、AA 数据或密钥提交到公共仓库。浏览器已复验 CogineLLM 128 条 P 列表、ModelScope 37 条及 C/P 身份桥、Go 的 19 条来源补录、全局 2,221 条与短窗口覆盖，控制台无错误。最终秘密扫描覆盖 295 份产物/修改文件、277 份 JSON 解码内容，对 15 个非空专用变量内容匹配为 0；收据与报告 hash 放在忽略目录，避免将认证资料作为公共 fixture。

未执行安装版客户端流程、模型推理、账户资格、DNS 或生产发布。生产 AA/C/P 集成与来源公开再分发条件仍是后续工作，不能称为可以上线。
