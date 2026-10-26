# CW Provider 注册、控制台与验证凭据（2026-10-27）

按台北日期核实官方公开网页。CW 当前源码 HEAD 为 `f06181cbc864bdc3938d45920a86a5724fdd1c48`，内置定义共 **39 项**，包含地区、套餐、本地服务、订阅 OAuth 和退役兼容条目，不等于 39 家独立厂商或 39 个当前可见选项。AA 是 C 数据源、Vercel 是 P 数据源，它们不是当前 CW 内置 Provider。用户自定义连接另计。

## DashScope 旧控制台迁移

截图中的 `dashscope.console.aliyun.com` 是旧控制台。当前中国区普通 API Key 在 [阿里百炼 Key 管理](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，国际区在 [Model Studio Key 管理](https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key)。[阿里官方文档](https://help.aliyun.com/zh/model-studio/get-api-key) 仍提供 `https://dashscope.aliyuncs.com/compatible-mode/v1`；旧控制台下线不是 API 停服的证据。

本仓库变量 `MODELSPAGE_VALIDATE_DASHSCOPE_API_KEY` 与 CW 的 Provider ID 保持不变；不要因控制台迁移而改写执行地址。Coding Plan、Token Plan、普通按量 Key 要与相应产品和地区匹配。

## 完整 39 项

表中链接来自官方公开文档或官方页面导航。登录后的控制台、注册、开通和创建 Key 未执行；没有文档支持的深层 Key URL 保持空缺。

| CW Provider ID | 名称 | 注册 / Key 入口 | 当前验证路径 | 官方依据 |
| --- | --- | --- | --- | --- |
| `coginework-local` | CogineWork Local | 本地服务，无需注册 | 本地目录；非公共采集 | 固定CW源码 |
| `coginellm` | CogineLLM | [注册 / 控制台](https://llm.cogine.ai/) | 可携专用Key请求模型列表 | 固定CW源码 |
| `ollama` | Ollama | 本地服务，无需注册 | 本地目录；非公共采集 | [官方1](https://ollama.com/download) · [官方2](https://docs.ollama.com/api/authentication) |
| `lmstudio` | LM Studio | 本地服务，无需注册 | 本地目录；非公共采集 | [官方1](https://lmstudio.ai/download) · [官方2](https://lmstudio.ai/docs/developer/core/authentication) |
| `ollama-cloud` | Ollama Cloud | [注册 / 控制台](https://ollama.com/signin) · [Key 管理](https://ollama.com/settings/keys) | 可携专用Key请求模型列表 | [官方1](https://docs.ollama.com/cloud) · [官方2](https://docs.ollama.com/api/authentication) |
| `openrouter` | OpenRouter | [注册 / 控制台](https://openrouter.ai/) · [Key 管理](https://openrouter.ai/workspaces/default/keys) | 可携专用Key请求模型列表 | [官方1](https://openrouter.ai/) · [官方2](https://openrouter.ai/workspaces/default/keys) |
| `github-models` | GitHub Models | 已退役 | 当前适配器按固定目录/资料验证 | [官方1](https://docs.github.com/en/github-models) |
| `modelscope` | ModelScope | [注册 / 控制台](https://modelscope.cn/) · [Key 管理](https://modelscope.cn/my/myaccesstoken) | 可携专用Key请求模型列表 | [官方1](https://github.com/modelscope/modelscope-skills/blob/main/README.md) · [官方2](https://modelscope.cn/docs/accounts/token) |
| `dashscope` | DashScope | [注册 / 控制台](https://bailian.console.aliyun.com/) · [Key 管理](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) | 可携专用Key请求模型列表 | [官方1](https://help.aliyun.com/zh/model-studio/get-api-key) · [官方2](https://help.aliyun.com/zh/model-studio/regions) |
| `aliyun-codingplan` | Aliyun Coding Plan (China) | [注册 / 控制台](https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan) | 当前适配器按固定目录/资料验证 | [官方1](https://help.aliyun.com/zh/model-studio/coding-plan) · [官方2](https://help.aliyun.com/zh/model-studio/coding-plan-faq) |
| `aliyun-codingplan-intl` | Aliyun Coding Plan (International) | [注册 / 控制台](https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/coding-plan) | 当前适配器按固定目录/资料验证 | [官方1](https://www.alibabacloud.com/help/en/model-studio/coding-plan) |
| `aliyun-tokenplan` | Aliyun Token Plan | [注册 / 控制台](https://bailian.console.aliyun.com/cn-beijing?tab=plan) · [Key 管理](https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal) | 当前适配器按固定目录/资料验证 | [官方1](https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start) · [官方2](https://help.aliyun.com/zh/model-studio/token-plan-overview) |
| `aliyun-tokenplan-intl` | Aliyun Token Plan (International) | [注册 / 控制台](https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/overview) | 当前适配器按固定目录/资料验证 | [官方1](https://www.alibabacloud.com/help/en/model-studio/token-plan-team-quickstart) |
| `opencode` | OpenCode Zen | [注册 / 控制台](https://opencode.ai/console/) | 公开目录已可请求 | [官方1](https://opencode.ai/v2/docs/console/models/) |
| `opencode-go` | OpenCode Go | [注册 / 控制台](https://opencode.ai/console/) | 公开目录已可请求 | [官方1](https://opencode.ai/v2/docs/console/go/) |
| `kilo` | Kilo Code | [注册 / 控制台](https://app.kilo.ai/) | 公开目录已可请求 | [官方1](https://kilo.ai/docs/getting-started/setup-authentication) · [官方2](https://kilo.ai/docs/gateway/authentication) |
| `openai` | OpenAI | [注册 / 控制台](https://platform.openai.com/) · [Key 管理](https://platform.openai.com/api-keys) | 可携专用Key请求模型列表 | [官方1](https://developers.openai.com/api/docs/quickstart) · [官方2](https://platform.openai.com/) |
| `tokendance` | TokenDance | [注册 / 控制台](https://tokendance.space/) | 公开目录已可请求 | [官方1](https://tokendance.space/) |
| `openai-response` | OpenAI (Response API) | [注册 / 控制台](https://platform.openai.com/) · [Key 管理](https://platform.openai.com/api-keys) | 可携专用Key请求模型列表 | [官方1](https://developers.openai.com/api/docs/quickstart) · [官方2](https://platform.openai.com/) |
| `openai-codex` | OpenAI Codex (ChatGPT Plus/Pro) | [注册 / 控制台](https://chatgpt.com/) | 订阅OAuth；非公共采集 | [官方1](https://learn.chatgpt.com/docs/auth) |
| `azure-openai` | Azure OpenAI | [注册 / 控制台](https://ai.azure.com/) · [Key 管理](https://portal.azure.com/) | 当前适配器按固定目录/资料验证 | [官方1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-thinking) · [官方2](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses) |
| `anthropic` | Anthropic | [注册 / 控制台](https://platform.claude.com/) · [Key 管理](https://platform.claude.com/settings/keys) | 可携专用Key请求模型列表 | [官方1](https://platform.claude.com/docs/en/get-api-key) · [官方2](https://platform.claude.com/settings/keys) |
| `gemini` | Google Gemini | [注册 / 控制台](https://aistudio.google.com/) · [Key 管理](https://aistudio.google.com/api-keys) | 可携专用Key请求模型列表 | [官方1](https://ai.google.dev/gemini-api/docs/api-key) |
| `deepseek` | DeepSeek | [注册 / 控制台](https://platform.deepseek.com/) · [Key 管理](https://platform.deepseek.com/api_keys) | 可携专用Key请求模型列表 | [官方1](https://api-docs.deepseek.com/) |
| `kimi-cn` | Kimi (China) | [注册 / 控制台](https://platform.kimi.com/console) | 可携专用Key请求模型列表 | [官方1](https://www.kimi.com/help/kimi-api/api-troubleshooting) · [官方2](https://platform.kimi.com/) |
| `kimi-intl` | Kimi (International) | [注册 / 控制台](https://platform.kimi.ai/) | 可携专用Key请求模型列表 | [官方1](https://www.kimi.com/help/kimi-api/api-troubleshooting) · [官方2](https://platform.kimi.ai/) |
| `kimi-codingplan` | Kimi Coding Plan | [注册 / 控制台](https://www.kimi.com/code/console) | 当前适配器按固定目录/资料验证 | [官方1](https://www.kimi.com/code/docs/) · [官方2](https://www.kimi.com/code/docs/kimi-code/faq.html) |
| `minimax-cn` | MiniMax (China) | [注册 / 控制台](https://platform.minimax.cn/login?source=platform_docs) · [Key 管理](https://platform.minimax.cn/console/access?tab=api-keys) | 当前适配器按固定目录/资料验证 | [官方1](https://platform.minimax.cn/docs/guides/quickstart-preparation) |
| `minimax` | MiniMax (International) | [注册 / 控制台](https://platform.minimax.io/login?source=platform_docs) · [Key 管理](https://platform.minimax.io/console/access) | 当前适配器按固定目录/资料验证 | [官方1](https://platform.minimax.io/docs/guides/quickstart-preparation) |
| `zhipu-cn` | Zhipu (BigModel) | [注册 / 控制台](https://open.bigmodel.cn/) · [Key 管理](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) | 可携专用Key请求模型列表 | [官方1](https://docs.bigmodel.cn/cn/guide/start/quick-start) · [官方2](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management) |
| `zhipu-cn-codingplan` | Zhipu Coding Plan (BigModel) | [注册 / 控制台](https://bigmodel.cn/coding-plan/personal/overview) | 当前适配器按固定目录/资料验证 | [官方1](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management) · [官方2](https://docs.bigmodel.cn/cn/coding-plan/overview) |
| `zhipu-intl` | Zhipu (Z.AI) | [注册 / 控制台](https://z.ai/) · [Key 管理](https://z.ai/manage-apikey/apikey-list) | 可携专用Key请求模型列表 | [官方1](https://docs.z.ai/guides/overview/quick-start) |
| `zhipu-intl-codingplan` | Zhipu Coding Plan (Z.AI) | [注册 / 控制台](https://z.ai/manage-apikey/apikey-list) | 当前适配器按固定目录/资料验证 | [官方1](https://docs.z.ai/devpack/quick-start) · [官方2](https://docs.z.ai/llms.txt) |
| `siliconflow-cn` | SiliconFlow (China) | [注册 / 控制台](https://cloud.siliconflow.cn/) · [Key 管理](https://cloud.siliconflow.cn/account/ak) | 可携专用Key请求模型列表 | [官方1](https://docs.siliconflow.cn/docs/userguide/quickstart) |
| `siliconflow-intl` | SiliconFlow (International) | [注册 / 控制台](https://cloud.siliconflow.com/) · [Key 管理](https://cloud.siliconflow.com/account/ak) | 可携专用Key请求模型列表 | [官方1](https://docs.siliconflow.com/en/userguide/quickstart) |
| `volcengine-cn` | Volcano Engine | [注册 / 控制台](https://ark.volcengine.com/) · [Key 管理](https://ark.volcengine.com/region:cn-beijing/apikey) | 可携专用Key请求模型列表 | [官方1](https://docs.volcengine.com/docs/ark/quick-start?lang=en) · [官方2](https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh) |
| `volcengine-cn-codingplan` | Volcano Engine Coding Plan | [注册 / 控制台](https://ark.volcengine.com/) | 当前适配器按固定目录/资料验证 | [官方1](https://docs.volcengine.com/docs/ark/coding-plan-personal-faq?lang=zh) · [官方2](https://docs.volcengine.com/docs/ark/coding-plan-personal-get-started?lang=en) |
| `mimo-tokenplan` | Xiaomi MiMo Token Plan | [注册 / 控制台](https://platform.xiaomimimo.com/token-plan) | 当前适配器按固定目录/资料验证 | [官方1](https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration) · [官方2](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription) |
| `agnes` | Agnes AI | [注册 / 控制台](https://platform.agnes-ai.com/) | 当前适配器按固定目录/资料验证 | [官方1](https://wiki.agnes-ai.com/en/docs/quickstart) · [官方2](https://agnes-ai.com/en/docs/overview) |

## 当前还需要哪些 Key

已有专用变量：AA、OpenRouter、Ollama Cloud、CogineLLM。后两项已分别完成携 Key 的目录请求；这些观察不等于推理资格或全部账号目录验收。ModelScope、Zen/Go、Kilo、TokenDance 的公开目录已取得，暂不必为了本轮目录验证额外提供 Key。

下一批尚未成功刷新的是 13 个 Provider，OpenAI 两个协议入口可共用，因此最少还需 **12 份 Key**。填写仓库根目录未提交的 `.env.validation` 即可；允许分批。

| Provider | 变量名 | 注册 / Key |
| --- | --- | --- |
| DashScope | `MODELSPAGE_VALIDATE_DASHSCOPE_API_KEY` | [打开官方入口](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) |
| OpenAI | `MODELSPAGE_VALIDATE_OPENAI_API_KEY` | [打开官方入口](https://platform.openai.com/api-keys) |
| Anthropic | `MODELSPAGE_VALIDATE_ANTHROPIC_API_KEY` | [打开官方入口](https://platform.claude.com/settings/keys) |
| Google Gemini | `MODELSPAGE_VALIDATE_GEMINI_API_KEY` | [打开官方入口](https://aistudio.google.com/api-keys) |
| DeepSeek | `MODELSPAGE_VALIDATE_DEEPSEEK_API_KEY` | [打开官方入口](https://platform.deepseek.com/api_keys) |
| Kimi (China) | `MODELSPAGE_VALIDATE_KIMI_CN_API_KEY` | [打开官方入口](https://platform.kimi.com/console) |
| Kimi (International) | `MODELSPAGE_VALIDATE_KIMI_INTL_API_KEY` | [打开官方入口](https://platform.kimi.ai/) |
| Zhipu (BigModel) | `MODELSPAGE_VALIDATE_ZHIPU_CN_API_KEY` | [打开官方入口](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) |
| Zhipu (Z.AI) | `MODELSPAGE_VALIDATE_ZHIPU_INTL_API_KEY` | [打开官方入口](https://z.ai/manage-apikey/apikey-list) |
| SiliconFlow (China) | `MODELSPAGE_VALIDATE_SILICONFLOW_CN_API_KEY` | [打开官方入口](https://cloud.siliconflow.cn/account/ak) |
| SiliconFlow (International) | `MODELSPAGE_VALIDATE_SILICONFLOW_INTL_API_KEY` | [打开官方入口](https://cloud.siliconflow.com/account/ak) |
| Volcano Engine | `MODELSPAGE_VALIDATE_VOLCENGINE_CN_API_KEY` | [打开官方入口](https://ark.volcengine.com/region:cn-beijing/apikey) |

`openai-response` 可复用 `MODELSPAGE_VALIDATE_OPENAI_API_KEY`；其专用变量也可以单独填写。地区和套餐 Key 不自动跨入口复用。Kimi 当前平台域名为 `platform.kimi.com` / `platform.kimi.ai`，API 仍保留 `moonshot.cn` / `moonshot.ai`，账号、余额和 Key 按官方说明区分。

Agnes、各 Coding/Token Plan 及 MiniMax 等当前目录策略是 `catalog_only`，不代表本项目已证明厂商永远没有模型接口。它们的账号入口列在上表，当前先按公开资料核对，不收集用不上的凭据。Azure 是资源/部署目录，Codex 是订阅 OAuth，本地三个入口是本机服务，这些不以公共 Provider API Key 代替验收。

## 其他入口变化

- Anthropic 当前官方 Console 使用 `platform.claude.com`；API Key 页面为 `/settings/keys`。

- MiniMax 中国区旧 `platform.minimaxi.com` 文档重定向到 `platform.minimax.cn`，Key 页面为 `/console/access?tab=api-keys`；国际区是 `platform.minimax.io/console/access`。官方新 API 示例与 CW 当前中国区执行地址存在差异，本轮只记录差异，没有修改 CW。

- BigModel 官方公告将新建标准 API、个人套餐、团队套餐 Key 分开管理；已有兼容 Key 不因这次入口整理而被要求更换。使用上表相应产品入口。

- Xiaomi MiMo 官方 [FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration) 将按量 [API Keys](https://platform.xiaomimimo.com/#/console/api-keys) 与 Token Plan [专属Key管理](https://platform.xiaomimimo.com/#/console/plan-manage) 分开；CW 当前只内置 MiMo Token Plan。

- Agnes [官方仓库](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/README.md) 列出国际官网、中国官网与 `platform.agnes-ai.com` 注册平台；精确 Key 子页没有猜测。TokenDance 官网为 `tokendance.space`，精确 Key 子页未核实。

- [GitHub 官方文档](https://docs.github.com/en/github-models) 明确 GitHub Models 已于 2026-07-30 全面退役；CW 中对应条目也是 retired，不应继续引导新建 PAT 开通。

## 本次新增 CogineLLM 目录证据

台北 2026-10-27 00:19:42–49，仅对 `https://llm.cogine.ai/v1/models` 发起 GET：此前匿名 401，本次携专用 Key 为 200，返回 16 个精确 ID。来源有 `created` 而无 `release_date`，没有把 created 当作 N；也没有凭 ID 相似性为该网关猜测跨路由 C/P/N。

固定 CW 源码声明 `cogine/free` 为原生模型，发现函数过滤远端重复，而完整列表仍合并原生与发现模型。初版报告直接用发现列表代替完整上下文，会漏掉这个原生模型。本次补正为 **15 个远端发现 +1 个原生保留 =16 个完整客户端上下文**；不对其他 Provider 一律合并旧 fallback。

来源依据：`provider_catalog.py:241`、`coginellm_provider.py:136`、`provider_manager.py:3800`、`provider.py:721`，均对照固定 CW HEAD。原生 seed 使用随包元数据，不伪装成新抓取资料；本次列表确实含该 ID，因此仅标明实时成员已确认。

目前真实目录刷新成功 8 个 Provider、1,177 个来源 ID、1,115 个远端发现投影；完整诊断 1,416 条记录，其中客户端上下文 1,307、来源补录 109。C 515 /P 241 /日精度 N 1,097 不变。目录响应/hash、历史及最后有效输入保留在忽略目录；没有模型推理、注册登录、购买或生产发布。

完整入口逐项证据在本地 `.modelspage/full-validation/provider-links-{asia,global}.json`；注册入口公开资料不含密钥。CW 源码未修改。新增原生模型保留回归后，固定 Bun 1.4.4 完整套件为 118 pass、0 fail、679 assertions；类型检查和 schema 一致性通过。
