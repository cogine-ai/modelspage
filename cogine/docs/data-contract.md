# 数据与客户端合同 v1

规范来源是 [`types.ts`](../src/types.ts)、[`schema.ts`](../src/schema.ts) 及生成的 [`schema/`](../schema/)；机器校验用严格对象，未知字段、无效枚举、非有限分数和不兼容结构会被拒绝。修改合同必须同时更新 schema、正反例、样例和兼容测试。

## 发布单位

客户端先读取 `/v1/manifest.json`，再读取其唯一必需对象 `/v1/revisions/<revision>/catalog.json`。首版合并 metrics、corrections 和 sources，避免多个文件分别切换造成 C/P/N 混用。

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 当前结构版本 1；不兼容结构拒绝应用 |
| `revision` | 对稳定序列化的 catalog 内容计算 SHA-256，排除 revision 自身；固定输入、builder_version、时钟和序号可复现 |
| `publication_sequence` | 单调递增的发布顺序；回退的 manifest 允许用更高序号指向已验证旧 catalog，不改旧对象 |
| `published_at` | 这次 publication 的发布时间；不等于来源更新时间 |
| `objects.catalog` | manifest 必需对象的精确路径、SHA-256、UTF-8 字节数 |
| `builder_version` | 构建语义版本，进入 catalog 修订身份 |
| `source_revisions` | 各输入 commit/URL/hash、状态、真实来源时间、统计窗口和使用条件 |
| `metric_profiles` | 每种能力指标的来源、方法版本、方向、任务、模型快照、推理配置、实际评测条件与使用条件 |
| `module_compatibility` | projection 合同版本和最低消费者版本 |
| `facts` | 身份限定的显示资料及 release/capability/popularity 字段事实；生产采用稀疏证据集合 |
| `mappings` | 经过审核、字段限定的显式关联；不包含用户账户数据 |
| `corrections` | 有序、可追溯的替换、冲突和撤回记录 |
| `attribution` | 来源、许可、链接和必要署名 |
| `fixture` | 测试资料标记；真实发布拒绝 fixture |

catalog 和 manifest 的 revision 必须一致，对象 hash/大小和模块兼容信息必须一致；manifest 序号不能早于其指向的 catalog。ETag 用于 HTTP 条件请求与发布 CAS，不能代替 SHA-256 内容校验。

生产 facts 是稀疏证据集合，只传输有效 N、显式 C/P 事实及映射/纠错所需的审核身份。缺席的模型仍可在客户端可用目录内，关联结果为 unmatched/unknown，按已声明的兜底顺序显示。稠密来源 inventory 和字段覆盖统计由 reports 生成，不随客户端对象传输。显式提供但未经许可的指标事实仍会到达发布校验并被拒绝，不能借稀疏化绕过使用条件。

## 身份与字段

身份由 `provider`、`request_model_id`、`scope.route`、`scope.region`、`scope.plan`、`scope.protocol` 组成。只有当前 Provider 模块能解释用户连接实际所属的 scope，公共投影不猜测账户、地域或套餐。显示名称和 canonical ID 不能替代请求身份。

每个字段采用四态：

- `known`：带 value、source_id、retrieved_at、data_as_of 和 evidence。
- `unknown`：有 reason，没有猜测出的零值。
- `withdrawn`：有 reason 和 correction_id，阻止旧快照回填。
- `conflict`：有 reason，不选最高分或最新下载的一方。

`retrieved_at` 是实际获取来源资料的时间；`data_as_of` 是来源说明的底层数据更新时间，缺失为 null；`window.start/end` 是来源明确的统计边界，未说明时为 null。只有来源声明的时间才能填入对应字段。来源状态区分 success、not_modified、failed、partial、disabled；失败和部分响应保留最后有效字节及其原时间，不清空事实。

日期 value 保存 `date`、`precision`、`verified` 和 `version_specific`。原始月/年精度可以作为资料保留，但只有四项同时满足可信日精度、已核验、具体版本、已发生，才进入有效 N。上游 release_date 尚未核验时在来源层标为 verified=false；生产选择的审核身份若没有适用日期，则发布 unknown 及原因，不因 canonical 相同自动获得另一个版本的日期。已明确审核的月/年精度保持原精度，不能补造为月初或年初。

capability value 必须匹配已选 profile 的 source、方法、模型快照与推理配置；同一索引只使用一个 profile。popularity value 保存来源 entry ID、快照位置及 `ranking_eligible`。位置只是来源快照顺序；只有逐项覆盖已核实且使用条件明确的条目才有排序资格，不代表 token 数值或全市场名次。

## 关联、纠错与权威

匹配顺序是完整 scope 后的 exact request_model_id，再使用明确审核过且允许该字段的 mapping。返回 matched / unmatched / ambiguous / conflict。登记冲突或撤回关联时，即使 exact 命中也不能掩盖问题。不自动删除前缀、版本、日期、`:free`、`:cloud` 或量化后缀。多个候选不按名字相似度或最高分自动绑定。

纠错只作用于完整 identity 和指定字段，记录审核者、审核时间、依据、原因和递增 sequence。replace、withdraw、conflict 先于旧上游和缓存回填；日期可纠正得更早。对同序号不同内容的冲突拒绝构建。撤回后重新启用必须提交更高序号的明确审核动作。

源码中的 applyCorrections 在构建与消费投影中均可执行。回退或升级随包数据不能丢掉客户端已观察到的有效纠错，包括 replace、withdraw 和 conflict；缺少当前有效修订的旧版本会被拒绝。更高字段 sequence 的明确审核动作可以取代旧动作，但相同纠错 ID 的内容不能改写。公共目录缺席本身不等于账户不可用或退役。

完整的新热度快照不沿用缺席条目的旧排序位置。历史模型成员仍保留，其热度为 unknown，不能解释为零用量或账户不可用。当前审核配置控制再分发权限与逐项排序资格；旧快照或旧 catalog 保存的允许值不能覆盖新配置。采集按解析后的模型 ID、顺序和资格判断变化，无关响应字段或 JSON 排版变化不制造新资料时间。重新应用的纠错若携带已失效的可排序热度证据，构建会拒绝并要求明确的新审核动作。

## 总排序与宿主职责

[`projection.ts`](../src/projection.ts) 是纯函数。输入为宿主当前完整可用上下文；输出同一成员集合的 capability、popularity、newest 三种总索引和解释。排序不会添加公共目录中的额外成员，不改变原模型 ID、路由、免费资格或其他宿主字段。

C 先分有效同 profile 证据/未知，再按分数方向、可信日期、Provider 展示次序、精确身份。P 先分明确同源且逐项覆盖的顺序/未知，再按来源位置、可信日期、Provider 次序、精确身份。N 按可信日期降序、Provider 次序、原目录位置、精确身份。比较键是完整稳定元组，避免“同 Provider 比 rank、跨 Provider 比日期”的非传递比较器。搜索与 Free 过滤在这些索引形成后进行；收藏保留用户自定次序。

消费端运行样例在 [`examples/`](../examples/)。它展示公共关联与投影，不实现 OAuth、账户目录、资格判断或任务选模。生产宿主可移植参考逻辑，不能动态下载执行这些 TypeScript 文件。

## 缓存与离线合同

[`client.ts`](../src/client.ts) 的 ReferenceCache 启动先验证兼容的最后有效持久缓存，缺失或不兼容时再用随包后备；应用升级保留兼容且更新的缓存。启动及投影本身没有网络请求。

宿主在后台显式触发 refresh，默认 24 小时检查，传递 ETag 并处理 304；并发刷新去重，失败退避。TTL 代表检查周期，不能到期删掉最后有效资料。先下载到 staging，验证所有字节、schema、revision 和兼容信息，持久化成功后一次切换内存版本。宿主提供的 writeSnapshot 必须使用已验证的临时文件、fsync 和原子替换；失败保留旧文件。

hash 错误、缺文件、旧序号、同序号冲突、不兼容版本或撤回记录丢失均拒绝替换。打开选择器和切换排序不触发公共请求；刷新不上传用户模型清单。撤回有正常检查周期的传播延迟，不承诺即时到达所有客户端。
