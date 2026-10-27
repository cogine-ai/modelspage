# 首版验收记录

任务日期：2026-10-26（Asia/Singapore）。本文件记录实际工程证据；长期规则在根 AGENTS.md。

本文件以下内容是首次实现及 PR #1 审核期间的历史记录。PR #1 后来已合并；旧的 N 人工核验门槛及“仅三条有效 N”结论已由用户纠正。后续修正、验证环境、未完成部署与约束问题见 [2026-10-26 约束审计](2026-10-26-constraints-review.md)，不要将历史限制当成当前需求。

## 仓库与输入

- 工作目录：`/Users/damonalbarn/Work/OrgRepos/ModelsPage`，独立于 CogineWork，没有 submodule。
- 目标仓库：[cogine-ai/modelspage](https://github.com/cogine-ai/modelspage)，初始化前 size=0、没有 HEAD/分支；未覆盖已有工作。
- 上游：[anomalyco/models.dev](https://github.com/anomalyco/models.dev)，导入其完整 Git 历史。
- 上游默认分支实测为 dev，固定 commit `4f1231e6bf72d5fa66dc1163599eaaedb607faab`；没有额外 models.dev API 快照。
- Bun 固定为 1.4.4，本地 `bun --version` 与 CI `.bun-version` 一致。
- 维护分支：`cogine/initial-release`；安全初始化基线为 `5a379ec41`，首版实现提交为 `f81f7bffe83dc0934fcf084c84c028efd79b1ec0`。[PR #1](https://github.com/cogine-ai/modelspage/pull/1) 保留人工审核，尚未合并。后续验收文档提交的最终 HEAD 可用 `git rev-parse HEAD` 及 `gh pr view` 核实。

## 已执行的专项证据

| 检查 | 结果 |
| --- | --- |
| 仓库为空、本地目录与上游默认分支核实 | 已执行；初始目标无分支，upstream/HEAD -> upstream/dev |
| 上游完整历史导入、origin/upstream 分离 | 已完成；保留原 LICENSE |
| 导入 workflow 安全处理 | 已移到 cogine/docs/upstream/workflows；活动 workflow 仅 Modelspage 自有四项 |
| `bun test cogine/test/sync-upstream.test.ts` | 3 pass，0 fail，9 expect；覆盖默认分支变化、无 symbolic HEAD/非法 ref 拒绝、受保护路径 |
| `bun cogine/scripts/sync-upstream.ts --check` | 已执行；发现 dev，commit 与 lock 一致，already_merged=true |

## 本地集成验收

以下检查实际完成，使用 Bun 1.4.4；安装完成后的 fixture 流程没有外网或秘密依赖。

| 实际命令或检查 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | PASS；锁文件无变化 |
| `bun run typecheck` | PASS；包括自有源码、脚本、测试和样例，以及引用的上游模块 |
| `bun run schema:generate`、`bun run schema:check` | PASS；JSON Schema 与运行时结构一致，字段语义仍需运行时校验 |
| `bun run test:cogine` | PASS；63 tests，352 assertions，9 个文件，0 fail |
| `bun run build:fixture`、`bun run validate:release --input dist/fixture` | PASS；固定输入重复构建内容一致，revision `554d027ab6af6b27d763e63ee660a423904d4afbaac41d563a34875f8bd20255` |
| `bun run publish:dry-run` 重复执行 | PASS；首次 published，再次 unchanged；修改内容仍沿用旧序号时正确拒绝，不覆盖已有模拟对象 |
| `bun run build --published-at 2026-10-26T00:00:00.000Z --sequence 1 --out-dir dist/real` | PASS；真实固定上游目录，无在线采集，重复构建 revision 一致 |
| `bun run validate:release --input dist/real` | PASS；生产候选 revision `eb35bf41fb43a43bfb3f256aa84c90591dba9bd61708a5770ff379a139359fff`，catalog 4,876 UTF-8 字节，3 条有效事实 |
| `bun run publish --dry-run --input dist/real --state-dir .modelspage/real-dry-run` | PASS；真实目录生成的候选通过无凭据模拟，重复执行 unchanged |
| `bun cogine/examples/consumer.ts` | PASS；宿主已有两成员在三套索引中保持同一集合，Free 过滤保留一项；不上传目录 |
| `bun validate` | PASS；继承目录校验通过；输出留在忽略的本地日志 |
| `bun run v1:check 4f1231e6bf72d5fa66dc1163599eaaedb607faab` | PASS；v1 output is byte-identical |
| 上游 `schema.test.ts` / `generate-v2.test.ts` 子集复核 | PASS；15 tests，72 assertions；完整生成器测试在复跑时约2.8秒通过 |
| `bun run upstream:sync --check` | PASS；在线发现 dev，固定 commit 与实际输入一致 |
| 四份 workflow `Bun.YAML.parse`、`git diff --check` | PASS；执行权限、部署门控和 GitHub 实际 CI 仍分别验证 |

测试覆盖精确 ID/作用域、free/cloud/版本/配置差异、canonical 字段边界、成员不扩张、四态与日期精度、不可比 profile、部分周榜拒绝、排序传递性、真实来源时间、撤回防复活、hash/缺文件/不兼容版本、缓存原子切换、304/去重/退避、无可写缓存时的随包后备、不可变路径、条件写竞争、旧发布拒绝、更高序号回退和无变化不制造发布时间。`fetch-current` 使用模拟 HTTP 验证完整当前版本、首次404、503与损坏对象；真实域名读取尚未执行。

覆盖快照已保存到 [`generated/coverage.md`](generated/coverage.md)、[`coverage.json`](generated/coverage.json)、[`sources.json`](generated/sources.json)。完整 inventory 用于覆盖统计，客户端对象是稀疏事实集合；不把 230 个公共 Provider 当作账户资格。`production_ready=false` 表示外部生产配置与上线验证尚未完成；`facts_publishable` 只描述数据用途检查。

## PR #1 Review 与远端 CI 跟进（2026-10-26）

本次修复代码提交：`8bc70f3dbcd94492e30d45d5b488489aacdf6dcc`。PR 保持未合并；后续验收文档提交不改运行代码。

### 排队根因与授权范围

旧运行 `40220870089` 长期显示 queued，但 jobs 为0。已通过 GitHub 设置页确认：组织的 Actions 策略为 Selected repositories，已选36个仓库，Modelspage 未在列表中；仓库页面显示被组织管理员禁用。这个状态没有进入 job 执行，不能解释为测试失败或 runner 容量不足。

用户明确授权仅为 Modelspage 启用 Actions 后，于 **2026-10-26 18:07:52（Asia/Singapore）** 将它加入允许列表，36→37；刷新后确认保存成功。其他仓库、action 来源策略、runner 设置、令牌默认权限、自动创建 PR 权限与生产发布开关均未更改。

### Findings 与验证

已逐条核实并处理8条 inline findings（其中历史热度问题被两个 reviewer 重复报告）及2项补充建议：

| 问题 | 修复与回归证据 |
| --- | --- |
| 回滚丢失 replace 纠错 | 发布器与消费者共用纠错连续性检查；replace、withdraw、conflict 的有效修订都必须保留或被更高审核修订取代；禁止重写旧纠错 ID |
| 历史 P 位置混入新完整快照 | 缺席或作用域不适用的历史位置变为 unknown；模型成员仍保留；重新应用纠错后再校验快照与当前资格，失效证据要求明确新纠错 |
| 冻结的来源许可盖过当前配置 | 当前经过校验的配置覆盖快照和旧 catalog 中的 usage；撤销再分发权限会阻止发布，署名及逐项排序资格也使用当前配置 |
| 无关响应变化制造数据 PR | 按解析后的 ID、顺序和资格判断变化；相同公开数据保留原 hash、时间及持久快照 |
| 不匹配的日期审核仍提供证据 | 仅日期和精度均匹配才应用审核证据和两个可信标记；不匹配降级为上游未审核事实 |
| 合并后 Bun preload 可进入写权限 job | 改用 jq 读取并校验 commit；合并后不再启动 Bun；新增 workflow 回归检查 |
| workflow 顶层默认写权限 | 默认 contents:read，写权限仅声明在 propose job |
| 保护路径检查仅存在于测试 | 实际暂存 merge diff 经过保护路径漂移检查；真实 Git 暂存区与含换行文件名回归覆盖 |
| 正例 fixture 未绑定原始字节 | 校验 manifest/catalog 实际 hash 与大小；损坏字节和错误 hash 均拒绝 |

远端 [PR CI 运行 40305084296](https://github.com/cogine-ai/modelspage/actions/runs/40305084296) 在上述代码提交上 **SUCCESS**，于 **2026-10-26 18:09:05（Asia/Singapore）** 完成。日志实际记录 **75 pass、0 fail、416 assertions**，并通过冻结安装、类型检查、Schema 检查、fixture 构建、完整性校验、无凭据发布模拟和 artifact 上传。本地同一套检查也通过；四份 workflow 通过 actionlint 1.7.12（环境未安装可选 ShellCheck）。

真实固定上游构建再次通过，revision 仍为 `eb35bf41fb43a43bfb3f256aa84c90591dba9bd61708a5770ff379a139359fff`，覆盖和生产限制没有改变。fixture revision 仍为 `554d027ab6af6b27d763e63ee660a423904d4afbaac41d563a34875f8bd20255`；重复 dry-run 分别返回 published、unchanged。原来的 queued 运行不作为通过证据；被 concurrency 取消的重复运行也不计入失败或 PASS。

当时 Actions 的自动创建 PR 权限由组织关闭，不影响上述只读 PR CI。2026-10-27 用户已在组织与仓库设置中勾选并保存自动创建 PR 权限，两个 `/actions/permissions/workflow` 接口均读回 `can_approve_pull_request_reviews=true`；默认 token 权限仍为 read，无需提高默认权限。该阻塞已经解除；真实自动提案流程另行验收，不能用权限配置成功代替运行成功。真实 R2 认证、CDN、生产发布与模型推理均未执行。

## 上游额外测试的失败与限制

额外运行了 `bun run test:upstream`。未修改的继承测试存在断言失败和默认5秒超时；全量运行已中止，**不报告为通过**。单独复现 `bun test packages/core/test/github-copilot.test.ts --timeout 30000` 为 22 pass、1 fail：`a price update keeps the mid-conversation flags copied from Anthropic`，位置 `packages/core/test/github-copilot.test.ts:308`。该测试涉及未使用的上游 Copilot 采集模块，本次没有改写上游核心来掩盖失败。

额外的 schema / generate-v2 子集首次为14 pass、1个全目录生成超时（测试本身固定15秒上限）；结束并行的全套继承测试后复跑为15 pass、72 assertions，生成器测试约2.8秒。继承输入的 `models/`、`providers/`、`packages/core/` 与固定上游 commit 比较无差异。这个复核不代表存在已复现断言失败的全量继承套件通过。

## 已实现但未执行的外部操作

- R2 S3 认证、桶写入、自定义域名公开对象与 CDN/CORS 的真实验证：未执行，没有生产配置或凭据。
- 生产发布、正式回退和向客户端发布撤回：未执行；实现可本地模拟。
- 模型推理：未执行，本项目验收不需要调用推理接口。
- CogineWork 集成：未修改该仓库；交付公共合同、消费样例和纯投影测试。
- 未来上游 merge 冲突的实际人工解决：未发生，不声称已经验证所有未来冲突。

## 来源及剩余配置

C 只有 profile 合同和接入位置，生产能力事实未知；Artificial Analysis 的生产用途未确认，不发布其数据。P 的公共接口探测结果见 [来源核实记录](source-verification.md) 和 [机器报告](openrouter-probe.json)，但使用条件和逐项覆盖尚未确认，生产关闭。N 仅采用明确审核的三个 Anthropic 4.5 具体版本日期，其余保留原精度与未验证状态。当前固定目录真实构建得到 230 Provider、11,960 个带协议作用范围的身份；N 有效3项、C/P有效0项。这是公开目录覆盖，不代表 CogineWork 账户可用性。以真实构建覆盖矩阵和来源报告为准。

生产仍需真实自定义域名、独立 R2 桶、目标桶限定 Secret、Cache Rules/CORS（若适用）、GitHub production environment/变量，以及每个来源对应采集与公开分发的用途确认。没有这些条件不会阻塞离线工程闭环，也不宣称服务已上线。

## 2026-10-27 每日 C/P 集成补验

每日 C/P 已与模型目录/N构建同一固定审核版本，使用加密输入保留未公开数据；旧缓存与未改事实不伪刷新。详见 [每日集成及完整覆盖](2026-10-27-daily-cpn-integration.md)。本轮 179 tests / 1,133 assertions、类型与schema检查通过；39 Provider/2,217行全盘及与每日纯投影逐条比对通过。真实内部生产候选 C6,733/P3,304/N11,855（协议身份计数），本地发布模拟 published→unchanged；外网部署未执行，公开许可检查仍拒绝未授权来源。新定时workflow需要PR2合并后才生效，未声称实际定时或自动发布已运行。
