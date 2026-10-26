# 2026-10-26：来源信任、约束审计与上线边界

本次只修改 Modelspage。现有上游 commit 保持 `4f1231e6bf72d5fa66dc1163599eaaedb607faab`，不改上游目录、解析器或 CogineWork。

## 用户已明确的需求

- models.dev 维护的字段和原解析器结果直接信任；不再要求逐模型本地独立核验或人工白名单。
- 首发要求主要 Provider 和模型有广泛的 C/P/N 覆盖，不能仅因三类各有一条就宣布可上线。具体核心名单与覆盖口径尚未定义，不能自行编造百分比。
- C 希望考察 Artificial Analysis 的综合排名；其官方 API 可取 Intelligence Index，但公共 JSON 再分发需要对应许可，尚未接入或购买。
- 审核 PR 合并后自动生产发布，保留手动重试。
- 用本地 Cloudflare 插件或 CLI 配置资源。

## 已纠正：N 的人工审核门槛

旧实现只有 `release-verifications.json` 中三个 Anthropic 身份被标为可排序，其他 models.dev 日期被降为未核验。旧覆盖报告实际已有 11,960 个日期事实；“只有三条”是本地规则造成的。

现在固定上游的合法 resolved `release_date` 直接受到信任，包括上游的 `base_model` 继承、覆盖及 alias 记录。可选本地 review 只补充证据，不再授予日期可用资格。`verified` 和 `version_specific` 保持 v1 结构兼容，含义是来源信任与该记录的适用性，不能宣称逐项人工核验。

以 `2026-10-26T00:00:00.000Z`、sequence=1 实际离线重建：230 Provider、11,960 个协议作用域身份、11,960 个原始日期事实、11,855 个有效日精度 N 身份。其余 105 个是月精度，当前固定输入没有未来日期；它们不是缺来源。保留缺失/非法日期检查、原始精度、不从名称推导日期，以及明确冲突/纠错/撤回优先级。

## 其余审计结论（未批量移除）

| 问题 | 影响与建议 | 源码 |
| --- | --- | --- |
| P 逐模型本地白名单 | 合法来源的榜单仍须逐个加入 `ranked_ids` 并提供本地证据；build 再做一次 AND。应按来源声明的榜单范围接纳数据，保留来源窗口、截断边界和显式排除；无需重复人工证明每条来源事实。 | `cogine/src/adapters/openrouter.ts`、`cogine/src/build.ts` |
| C 混淆模型版本和评测版本 | 同一 profile 要求所有模型的 `model_snapshot`、`inference_config` 与 profile 单值完全相同。按现合同“被测模型快照”解释，不同模型不能共榜。应分开评测方法/版本与各被测模型的版本/配置，采用来源自己的可比较口径。 | `cogine/src/schema.ts`、`cogine/src/projection.ts` |
| C 尚无首次构建输入 | C 和 profile 仅从 previous production 继承；首次不存在 previous，不能靠开关得到能力数据。应给已选来源普通、固定的 adapter/构建输入。 | `cogine/src/build.ts` |
| 模型事实绑定全部连接维度 | 日期、能力也按 route/region/plan/protocol 精确关联；adapter 又统一填 public/global/public。真实宿主连接维度稍有不同就失配，应按字段区分模型事实、Provider override 和执行身份。 | `cogine/src/types.ts`、`cogine/src/adapters/upstream.ts`、`cogine/src/projection.ts` |
| 上游明确关联被降为展示元数据 | 已有 `base_model`/`canonical_model_id` 仍需另造本地审核 mapping 才能关联跨 Provider 公共事实。应直接使用上游明确关系，保留具体 variant、真实 override 和平台热度作用范围。 | 同上；`packages/core/src/generate-v2.ts` |
| 本地纠错缺少向上游收敛机制 | replace 永久压住后续所有上游版本，容易形成长期分叉。应标明适用来源修订及上游修复后的退出方式；撤回不能被旧快照复活仍需保留。 | `cogine/src/corrections.ts` |
| 部署报告写死状态 | 构建始终写 production_ready=false 及固定缺项，无法反映资源已创建。应分开数据状态和未实测的环境状态；构建本身不能证明真实部署。 | `cogine/src/build.ts` |
| 固定输入检查范围过宽 | 整个 packages/core 与 pin 不同即拒绝，连未参与生成的测试/文档也能挡住构建。应固定实际构建输入和明确 patch，不把整目录无差异当永久事实资格。 | `cogine/src/adapters/upstream.ts` |

上游本来区分 lab model 的跨宿主事实与 Provider 的服务覆盖，并明确公开 canonical_model_id；见 `cogine/docs/upstream/AGENTS.md` 的 Two concepts 及原 README 的 API Reference。直接复用这些已维护关系可以减少本地映射。

另外两项是范围取舍：上游合法月精度日期当前通常不随稀疏包分发；description、family、knowledge、modalities、limits、cost、capabilities 等字段也被当前公共合同裁剪。它们不是上游没数据。若基础资料也应在线更新，应透传上游结构，避免新建逐字段审核系统。

继续保留结构/有限值、hash/大小、不可变路径、条件写、发布序号、明确冲突撤回，以及公共资料不能改写客户端执行身份的边界。这些校验直接防止损坏和错误覆盖，不是在重复证明来源事实。

## C/P 来源事实

- [Artificial Analysis 官方 API](https://artificialanalysis.ai/data-api) 有综合 Intelligence Index。其 Free API 为内部使用，Pro 的有限外部使用不等于公开逐项 JSON；[Data Platform Terms](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf) 定义了 structured data 的外部分发和 Commercial Order Form。是否已有相应授权尚未知；没有调用认证接口、购买或发消息联系对方。
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) 明确提供最近一周 token 顺序。当前本地逐项白名单是额外门槛；来源公开使用条件仍须按实际 endpoint 处理。
- [OpenRouter Data API](https://openrouter.ai/docs/cookbook/administration/data-api) 的 rankings-daily 明确 CC BY 4.0，需 API key，只有每日 top 50 和 other；不能当成完整周榜，也不能据此宣称广泛覆盖已满足。
- [Epoch AI 数据许可](https://epoch.ai/benchmarks/use-this-data) 可作其他能力来源候选；本次未核验实际可比较行，不自动替代用户希望的综合能力指标。

## Cloudflare 和发布进展

本地 Wrangler 4.141.0 已认证到账户 `a11312197b2f8ff3e535b8c2f4ac9b22`，创建并读回确认专用 `modelspage-production` 桶（Standard/APAC）。没有复用 CogineWork 资产桶。自定义域名为空，r2.dev 访问关闭，未上传公共目录或 manifest；当前登录的 zones 查询为空，已询问正式域名及管理位置。专桶 S3 Secret、域名/缓存与线上条件写仍未验收。

用户提供了 `models.cogine.app`、`models.cogineai.com`、`models.cogine.ai` 三个候选。2026-10-26 实时 NS 查询分别得到 Vercel、DNSPod、Spaceship；`cogineai.com` 当前的 DNSPod 结果与“Cloudflare 管理”的描述不同，两个候选主域的 Cloudflare zone API 查询也为空，不能直接假定可绑定。建议品牌主地址采用 `models.cogine.ai`，其他地址后续可作为同一份数据的入口，不维护三套独立发布。R2 自定义域名所需的同账户 zone 接入方式尚未落实；未迁移任何现有 DNS。

仓库实现了合并 PR 后自动发布、可信 main SHA 判定、自动派生序号/固定时钟，并保持生产开关关闭。非空 C/P/N 检查只是最低条件，不表示广泛覆盖达标。新增检查中“采集许可当发布资格”的耦合已去掉：停止采集不自动撤销已有合法数据的再分发权。首次检查复用有效事实、线性遍历，避免逐项重新克隆整个包。

## 验证证据

早期部分检查使用本机 Bun 1.3.6。最终已获取固定 Bun 1.4.4，镜像下载字节与官方 npm SHA-512 完全一致；工具保存在忽略的 `.modelspage/tools/`。完整冻结安装使用该 Bun 完成，`bun.lock` 未变化。最终证据如下：

| 检查 | 结果 |
| --- | --- |
| Bun 1.4.4 冻结安装，ignore-scripts | 通过；使用镜像 registry 下载，锁文件完整性未改变 |
| TypeScript 5.8.2 typecheck | 通过 |
| Schema 一致性 | 通过；v1 JSON 结构未改 |
| Cogine 完整套件 | 88 pass、0 fail、502 assertions，13 文件 |
| 固定真实输入 build + validate + dry-run | 通过；revision `cb3db511312d84582b9ac6037fa5db4c6945813b665092c52840ecfb23e4120d`，11,855 条公开 N 身份 |
| Fixture build + validate + dry-run | 通过；revision `9657917de7e15555f8c8657c7e927b1d11adffd15614117be74ea453d729d160` |
| 真实候选的首发检查 | 按预期拒绝，仍缺 capability、popularity |
| Cloudflare CLI 认证、专桶创建及读回 | 已执行；桶为空，未启用公开访问 |
| 自定义域名、S3 凭据、真实发布/回退、模型推理 | 未执行；域名和 C/P 来源仍待落实 |

补充专项验证：发布资格检查遇到 GitHub API 失败时应让 job 失败并可重试，不能静默 publish=false；修复后 workflow 专项 3 pass、44 assertions。初次远端 CI 暴露浅克隆缺少固定上游 commit 的问题，已在只读 CI 显式抓取该锁定 SHA，未扩大为全历史下载；后续远端状态以 PR #2 最新 SHA 为准。

历史 `acceptance.md` 的三条 N/PR 未合并记录不再描述当前状态。
