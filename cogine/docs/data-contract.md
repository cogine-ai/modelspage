# 数据与客户端合同 v1 / v2

规范来源是 [`types.ts`](../src/types.ts)、[`schema.ts`](../src/schema.ts) 及生成的 [`schema/`](../schema/)；机器校验用严格对象，未知字段、无效枚举、非有限分数和不兼容结构会被拒绝。修改合同必须同时更新 schema、正反例、样例和兼容测试。

## 发布单位

客户端先读取 `/v1/manifest.json`，再读取其唯一必需对象 `/v1/revisions/<revision>/catalog.json`。首版合并 metrics、corrections 和 sources，避免多个文件分别切换造成 C/P/N 混用。

| 字段 | 含义 |
| --- | --- |
| `schema_version` | catalog 支持 1 与 2；加权 P/source headline 使用 v2。manifest 与 URL transport 仍为 v1 |
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

日期 value 保存 `date`、`precision`、`verified` 和 `version_specific`，结构保持 v1 兼容。`verified` 表示采纳该来源的日期事实，`version_specific` 表示该日期适用于来源的这个模型记录；两个字段都不表示 Modelspage 对每条日期做过独立人工核验。对于固定 models.dev commit，由其原解析器完成 `base_model` 继承和覆盖后提供的合法 `release_date` 直接受到信任，两个标记均为 true；不要求命中本地 `release-verifications.json` 白名单，也不根据模型名或滚动 alias 再加一层日期禁用规则。该文件只提供可选补充证据，日期与精度不匹配的旧补充记录不会降低上游日期的可信状态；明确的日期替换、冲突和撤回继续使用 corrections，优先于上游事实。

有效 N 使用已经发生的可信日精度日期。月/年日期保留上游原始精度，不能补造为月初或年初参与日精度排序；缺失或无效日期保持 unknown，未来日期不参与有效 N。不从 created、上架时间或 last_updated 推导发布日期，也不由本项目凭 canonical 相同额外继承日期；这里直接采用的是上游已解析完成的模型记录。

v1 capability 仍要求 profile 的 source、模型快照和推理配置逐项相同。v2 另提供明确的 `source-headline-v1` 比较政策，限定 AA Intelligence Index 同一方法版本的原站 headline；每个事实保留其实际 AA model_snapshot/inference_config，不能把它们改成全局假值以通过校验，也不选择最大分数。其他 profile 继续沿用 exact 比较规则。

v2 popularity 的 `weighted` 保存 method_id、实际观测合成分数、完整 UTC 日期、固定权重及每源每日 share/null、贡献和缺失日。`position` 是该观测合成分数的 dense rank，同分共享位置；不冒充平台原生或全市场名次。`source_revisions.popularity_method` 固定本批 dates/weights，eligible 事实必须与该批完全相符；不能混旧窗口、旧权重或 native position。全源缺失为 unknown，显式零为已知零，不逐模型重分配权重。原 v1 native position 只在原来源合同下解释。

`ranking_defaults` 在一个完整 catalog 内指定 C profile 和 P source。catalog v2 要求 projection 2 / consumer ≥2.0.0；新参考消费端仍可读 v1，旧消费端应保留旧缓存并拒绝未兼容的新版本。日期和执行身份结构不变。

## 关联、纠错与权威

匹配顺序是完整 scope 后的 exact request_model_id，再使用明确审核过且允许该字段的 mapping。返回 matched / unmatched / ambiguous / conflict。登记冲突或撤回关联时，即使 exact 命中也不能掩盖问题。不自动删除前缀、版本、日期、`:free`、`:cloud` 或量化后缀。多个候选不按名字相似度或最高分自动绑定。

纠错只作用于完整 identity 和指定字段，记录审核者、审核时间、依据、原因和递增 sequence。replace、withdraw、conflict 先于旧上游和缓存回填；日期可纠正得更早。对同序号不同内容的冲突拒绝构建。撤回后重新启用必须提交更高序号的明确审核动作。

源码中的 applyCorrections 在构建与消费投影中均可执行。回退或升级随包数据不能丢掉客户端已观察到的有效纠错，包括 replace、withdraw 和 conflict；缺少当前有效修订的旧版本会被拒绝。更高字段 sequence 的明确审核动作可以取代旧动作，但相同纠错 ID 的内容不能改写。公共目录缺席本身不等于账户不可用或退役。

完整的新热度快照不沿用缺席条目的旧排序位置。历史模型成员仍保留，其热度为 unknown，不能解释为零用量或账户不可用。当前审核配置控制再分发权限与逐项排序资格；旧快照或旧 catalog 保存的允许值不能覆盖新配置。采集按解析后的模型 ID、顺序和资格判断变化，无关响应字段或 JSON 排版变化不制造新资料时间。重新应用的纠错若携带已失效的可排序热度证据，构建会拒绝并要求明确的新审核动作。

## 总排序与宿主职责

[`projection.ts`](../src/projection.ts) 是纯函数。输入为宿主当前完整可用上下文；输出同一成员集合的 capability、popularity、newest 三种总索引和解释。排序不会添加公共目录中的额外成员，不改变原模型 ID、路由、免费资格或其他宿主字段。

C 先分有效同 profile 证据/未知，再按分数方向、可信日期、Provider 展示次序、精确身份。P 先分明确同源且逐项覆盖的顺序/未知，再按来源位置、可比较 C 的证据与分数方向、可信日期、Provider 次序、精确身份。因此 P 平局或 P 都未知时先用 C，C 也未知再用 N；P 已知的模型仍优先于 P 未知的模型。C 兜底沿用 C 索引所选 profile 及来源适用性，不能混入其他评测配置，也不会把能力分或发布日期写成热度事实。N 按可信日期降序、Provider 次序、原目录位置、精确身份。

这是一条作用于完整上下文的固定比较键，不按 Provider 是否有热度临时切换算法，避免“双方 P 已知才比 P，否则比 C”产生循环排序。所有指标均未知时沿用索引既有的稳定平局规则，不猜测分数；匿名模型不猜测其底层身份来填 C。搜索与 Free 过滤在这些索引形成后进行；收藏保留用户自定次序。v2 明确扩展 metric 合同并配套更新类型、JSON schema、正反例及兼容测试；执行身份不变。

消费端运行样例在 [`examples/`](../examples/)。它展示公共关联与投影，不实现 OAuth、账户目录、资格判断或任务选模。生产宿主可移植参考逻辑，不能动态下载执行这些 TypeScript 文件。

## 缓存与离线合同

[`client.ts`](../src/client.ts) 的 ReferenceCache 启动先验证兼容的最后有效持久缓存，缺失或不兼容时再用随包后备；应用升级保留兼容且更新的缓存。启动及投影本身没有网络请求。

宿主在后台显式触发 refresh，默认 24 小时检查，传递 ETag 并处理 304；并发刷新去重，失败退避。TTL 代表检查周期，不能到期删掉最后有效资料。先下载到 staging，验证所有字节、schema、revision 和兼容信息，持久化成功后一次切换内存版本。宿主提供的 writeSnapshot 必须使用已验证的临时文件、fsync 和原子替换；失败保留旧文件。

hash 错误、缺文件、旧序号、同序号冲突、不兼容版本或撤回记录丢失均拒绝替换。打开选择器和切换排序不触发公共请求；刷新不上传用户模型清单。撤回有正常检查周期的传播延迟，不承诺即时到达所有客户端。

## 固定每日输入与发布

每日 C/P 输入以认证加密快照审核，与候选模型目录/N的不可变 commit 一起构建。加密输入不是公开资料，也不能赋予第三方数据许可。构建只读已审核输入，不在发布时重新抓取或滚动日期；无变化复用原密文/来源时间，全部失败保留旧批次。当前审核政策控制来源权限，旧快照不能冻结过期许可。

历史事实可以保留原窗口证据，但超出当前 cohort 时不可参加 P 比较。纠错最后应用；旧纠错若重新启用不匹配窗口/权重的 P，构建拒绝并要求显式更高修订，不能静默改写 ledger。发布与消费投影均检查实际携带数据的 component 权限，复合来源不能洗白未授权原始数据。详见[每日集成记录](2026-10-27-daily-cpn-integration.md)。
