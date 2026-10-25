# Cogine Modelspage

Modelspage 发布公共模型资料、经过核验的身份关联和 C/P/N 排序事实，帮助 CogineWork 在不发版的情况下更新模型发现信息。选择器、排序切换和搜索使用本地完整版本，无需临时联网。公共资料不能增加账户可用模型、授予免费资格或改变请求 ID、地址和路由。

这是 [cogine-ai/modelspage](https://github.com/cogine-ai/modelspage) 独立维护的静态数据项目，基于 [anomalyco/models.dev](https://github.com/anomalyco/models.dev) 的完整 Git 历史。上游目录、解析器、MIT [LICENSE](LICENSE) 和版权保留；自有扩展集中在 [`cogine/`](cogine/)。原始 [README](cogine/docs/upstream/README.md) 和 [贡献规则](cogine/docs/upstream/AGENTS.md) 可查。导入的上游 workflows 已移到惰性 [归档](cogine/docs/upstream/workflows/)，本项目不运行上游网站部署、遥测、SDK 发布或机器人。

## 当前交付状态

| 项目 | 首版状态与限制 |
| --- | --- |
| 上游资料 | 复用上游 v2 生成器；固定输入 commit 和树 hash，不下载 models.dev API 快照冒充同版本 |
| N / 新 | 保留日期精度；仅经审核、对应具体版本且已经发生的日精度日期参与排序；原始 release_date 不自动视为可信首次日期 |
| P / 多 | 已实现 OpenRouter 周热度接口采集、分页/总量/结束校验、失败保留、来源状态；接口及派生结果使用条件未确认，生产未启用；无逐项覆盖证据的尾部不能冒充精确热度名次 |
| C / 好 | 已实现 metric profile、校验和投影入口；没有启用合法且可比较的生产评测，能力事实为 unknown，尚无可运营能力榜 |
| 消费端 | 纯匹配/投影及缓存参考实现、正反例和测试；没有修改 CogineWork |
| 发布 | 已实现 R2 S3 条件发布、远端/公开路径校验、无凭据持久化 dry-run、回退；真实生产默认关闭 |
| 生产环境 | 未配置自定义域名、独立桶或 Secret；未声称 CDN 已上线，未执行认证和真实部署 |

具体命令与验收证据见 [验收记录](cogine/docs/acceptance.md)，字段和 Provider 覆盖以每次构建生成的报告为准。

## 数据流程与职责

1. **上游层**：`models/`、`providers/`、`packages/core/` 保留上游组织；[`upstream.lock.json`](cogine/upstream.lock.json) 固定实际代码输入。独立下载的其他响应另记 URL、抓取时间与 hash。
2. **采集层**：[`adapters/`](cogine/src/adapters/) 解释来源语义；公共请求层负责超时、限流、条件请求和退避。不采集用户私有目录或资格。
3. **审核层**：[`config/`](cogine/config/) 保存字段限定的显式映射、日期核验、纠错/撤回及来源使用条件。人工精选不能充当能力或用量。
4. **发布层**：构建严格校验的不可变 `catalog.json`，小型 manifest 记录路径、SHA-256 和字节数；客户端只取紧凑事实，不取原始响应或执行脚本。

Provider 模块由 CogineWork 解释真实连接与请求身份。公共模块只对该上下文中已经可用的成员精确关联事实，再在本地形成 capability/popularity/newest 总索引；先排序后搜索/Free 过滤。收藏和任务选模继续由客户端管理。

## 本地运行

固定环境为 **Bun 1.4.4**，见 [`.bun-version`](.bun-version)、`packageManager` 和 [`bun.lock`](bun.lock)。安装 Bun 后进入本仓库根目录：

```sh
bun --version
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run schema:check
bun run test:cogine
bun run build:fixture
bun run validate:release --input dist/fixture
bun run publish:dry-run
```

安装依赖需要网络；安装完成后，上述类型检查、测试、fixture 构建和 dry-run 不需要外网或任何秘密。fixture 中的模型、分数与许可均为明确的合成测试资料，发布器拒绝把它们发送到生产。重复 `build:fixture` 得到相同内容；重复 dry-run 为无变化，不会制造新版本。

使用当前固定的真实上游目录，显式给定构建时钟和发布序号：

```sh
bun run build --published-at 2026-10-26T00:00:00.000Z --sequence 1 --out-dir dist/public
bun run validate:release --input dist/public
bun run coverage --published-at 2026-10-26T00:00:00.000Z --sequence 1 --out-dir dist/public
```

序号只是本地样例；发布前必须读取目标环境当前 manifest，使用更高序号。构建不自动取当前时间，固定输入、构建版本、时钟与序号可复现。没有事实变化时保留现有快照与资料时间，不为每日调度创建新生产发布。

采集与探测分开：

```sh
bun run collect
bun run collect --fixture --now 2026-10-26T00:00:00.000Z
bun run collect --probe
```

`collect` 按已提交的来源配置决定是否联网；默认未启用并报告 disabled。`--probe` 是维护者诊断真实公共接口，结果写到忽略的 `.sync/openrouter.json`，报告写到 `dist/reports/collection.json`，不会自动进入生产构建。`--fixture` 不联网。采集支持 `--state-path`、`--report-path` 和 `--now`，用于复现和 CI。只有经过用途审查的快照才能通过 PR 放入 `cogine/data/openrouter.json`，或在本地显式传 `build --snapshot <路径>`；发布前仍强制核实再分发许可。

## C / P / N 与身份合同

- **C / 好 / 能力优先**：选择一个明确 profile，同一方法、模型快照和推理配置内按分数方向排序。不同 profile 不混排。Artificial Analysis 只是候选来源，未确认公开分发权前不启用；Arena 人类偏好不自动等于通用能力。
- **P / 多 / 热度优先**：保留 OpenRouter 指定平台近周 token 使用热度的来源顺序。不是全市场用户数；没有数值就不编造 token、调用量或份额。接口快照总量完整不代表每项都有已核实用量覆盖；未上榜、新模型和未知都不等于零。
- **N / 新 / 最新发布**：具体版本可信首次公开日期，日精度、已经发生且无冲突。月/年精度保留，未来日期、滚动 alias、上架时间和不可靠日期不参与有效 N。

C/P 平局按可信日期、既定 Provider 次序、精确身份；N 平局按 Provider 次序、原目录位置、精确身份。某模式无证据时按明确兜底规则展示，并解释为未知，不能宣称兜底是能力/热度结论。路由器身份本身不置顶。

`request_model_id` 是实际发给 API 的模型 ID，绝不是单次请求追踪 `request_id`。身份包含 Provider、路由、地区、套餐和协议；大小写、标点、版本、`:free`、`:cloud` 等保留。首版只使用 exact 和经审核且字段适用的显式关联；其余保持 unmatched，维护者可离线审阅候选，未实现模糊匹配生成器。匹配区分 matched / unmatched / ambiguous / conflict，已记录 conflict 优先于 exact。canonical 相同不自动继承三个字段。

详细结构、时间语义和消费示例见 [数据与客户端合同](cogine/docs/data-contract.md)、[`schema/`](cogine/schema/) 和 [`examples/`](cogine/examples/)。

## 配置与生产分发

复制 [`.env.example`](.env.example) 到未提交的 `.env`。非秘密配置为 `MODELSPAGE_PUBLIC_BASE_URL`（真实 HTTPS 自定义域名 origin）、`MODELSPAGE_R2_ACCOUNT_ID`、`MODELSPAGE_R2_BUCKET` 和 `MODELSPAGE_PUBLISH_ENABLED`（默认 false）。秘密为 `MODELSPAGE_R2_ACCESS_KEY_ID`、`MODELSPAGE_R2_SECRET_ACCESS_KEY`。凭据只能访问本项目专用桶，不能复用 CogineWork 正式资产桶。首版公共来源无需账户目录或推理凭据。

公共路径采用一个合并后的紧凑对象：

```text
/v1/manifest.json
/v1/revisions/<revision>/catalog.json
```

`catalog.json` 合并 facts、metric_profiles、mappings、corrections、source_revisions、attribution 和 module_compatibility；这满足四类数据一致切换，不承诺完整 models.dev API 兼容。上游带下划线的内部 JSON、动态查询、schema 和 logo fallback 不在兼容范围。

生产 `facts` 采用稀疏发布：只携带有效排序证据、显式指标事实及映射/纠错涉及的身份。默认输入中，230 家 Provider 的 11,960 个协议作用域身份用于生成覆盖报告，客户端仅下载 3 条已核验 N 身份；未出现在公共 facts 的客户端模型视为无公共证据，继续参与本地兜底总序，不表示不可用或已退役。未核验的原始日期留在固定的上游资料中，不为每个未知模型重复传输。fixtures 保留较完整的正反例用于合同测试。实际数量以生成报告的 `inventory.model_identity_count` 和 `published_fact_count` 为准。

发布先完整校验，上传不可变对象并验证 R2 和自定义域名公开路径，再最后更新 manifest。同路径不同字节拒绝；已有 manifest 使用 ETag 的 If-Match，首次使用 If-None-Match:*。并发失败重读、比较序号，不无条件覆盖。旧版本保留，回退使用更高发布序号；已观察到的撤回/冲突不能因旧输入回退而丢失。

域名和权限配置、缓存/CORS、失败恢复及回退命令见 [部署手册](cogine/docs/deployment.md)。真实发布命令为 `bun run publish --input dist/public`，默认会被关闭开关或缺配置拒绝；无凭据模拟为 `bun run publish --dry-run --input dist/public --state-dir .modelspage/local-public`。

## 同步、维护与 CI

查看上游更新，自动发现其当前默认分支：

```sh
bun run upstream:sync --check
```

在干净的独立维护分支上准备保留历史的 merge：

```sh
git switch -c review/upstream-sync
bun run upstream:sync --merge
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test:cogine
bun validate
bun run v1:check <同步前固定的上游commit>
```

脚本保存上游 entry-point 文档/workflows 的惰性归档、保留本项目入口和活动 workflows、记录上游 commit；其他冲突保留 merge 状态并失败，按 [维护手册](cogine/docs/maintenance.md) 解决。不得直接用上游生产部署命令或覆盖 `cogine/`。新来源、身份映射、方法版本、重大纠错和异常删除均通过 PR 审阅。

[`.github/workflows/`](.github/workflows/) 提供：PR/主分支验证、手动/每日上游同步 PR、手动/每日来源采集，以及受保护 environment 的手动发布。PR 使用只读权限、无生产秘密；生产发布按环境串行并拒绝旧序号。采集产出审核工件；仅当已审查的配置同时允许采集和再分发、且获得完整变化快照时，才由独立最小权限任务创建数据审核 PR。未授权、未修改、失败和部分响应不会生成数据 PR，也不自动发布。调度频率不是上游新鲜度 SLA。

覆盖矩阵由构建生成：按真实上游 Provider inventory 列出字段支持、未覆盖、需认证、无公开来源和未验证，不引用历史“39 家”。输出为 `dist/<输出目录>/reports/coverage.json`、`coverage.md` 和 `sources.json`（默认真实构建为 `dist/public/reports/`），数据许可和真实探测见 [来源核实记录](cogine/docs/source-verification.md) 与 [验收记录](cogine/docs/acceptance.md)。
