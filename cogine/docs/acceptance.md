# 首版验收记录

任务日期：2026-10-26（Asia/Singapore）。本文件记录实际工程证据；长期规则在根 AGENTS.md。

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
