# 每日 C/P/N 审核流程接线（2026-10-27）

每日入口已统一为 [modelspage-collect.yml](../../.github/workflows/modelspage-collect.yml)：同一次运行准备 models.dev 目录／N 更新和一个加密 C/P 输入，在同一候选 Git tree 上验证，再生成一个审核 PR。旧 [modelspage-upstream.yml](../../.github/workflows/modelspage-upstream.yml) 只保留手动转调，不再独立定时或另开上游 PR。

当前唯一 cron 是 **`17 2 * * *`，每天 UTC 02:17，即台北时间 10:17**。GitHub Actions 的实际启动时间可能晚于该计划时间；来源事实仍使用实际采集时间与来源自己提供的数据时间。

本轮是流程实现与本地验证。主代理已完成三个 GitHub repository secrets 的配置；新调度尚未执行，仍待 PR #2 合并到默认分支。不能把配置完成或本地测试通过记作远端调度、自动开 PR 或生产发布已验收。

## 单次运行的数据与权限路径

| 阶段 | 执行代码与权限 | 输入／输出 |
| --- | --- | --- |
| `collect` | 固定触发 SHA 的 `trusted` checkout，仓库内容只读；来源 key 只在该受信采集步骤使用 | 解密已提交输入以 seed last-good；采集 C/P，输出加密 `rankings.json` 和安全操作报告 |
| `prepare` | 独立只读 runner；`trusted` 与 `candidate` 都从同一触发 SHA 开始 | 受信同步脚本准备完整上游 merge、固定 upstream lock，再加入本轮加密输入 |
| 整包验证 | 始终在 `trusted` cwd 执行绝对路径的受信 CLI，显式 `--root <candidate>` | 在同一候选目录／N／C/P 输入上构建与校验；结果保留在忽略目录，不上传明文 catalog |
| `propose` | 独立写入任务，仅用 Git、jq、gh；没有来源 key 或输入解密 key，不运行 Bun／候选代码 | 校对 base、候选 commit、加密输入 hash 及 bundle，再推送精确候选并创建 draft 审核 PR |

两个入口共享 `modelspage-daily-review` 并发组，`cancel-in-progress=false`。只有固定仓库、默认分支触发的受信流程能进入采集步骤；第三方 PR 不取得来源或解密 key。

编排逻辑位于 [daily-update.ts](../scripts/daily-update.ts)。上游合并继续发现远端 HEAD，而不是把某个上游分支名当作永久合同。上游 README、AGENTS 和 workflow 保留为惰性归档，本地执行 workflow 保持不变。

## 固定输入和失败处理

一次候选记录以下固定输入：

- 触发时的默认分支 commit、合并后的候选 commit、固定 models.dev commit。
- 加密排名文件的字节 hash、解密内容 hash、cohort `evaluation_date` 和来源数量。
- 本次审核构建的固定 `published_at` 及 sequence `1`。

加密 cohort 包含当次已接受的全局权重／窗口策略、来源快照和身份关联所需目录。构建使用 cohort 的 `evaluation_date` 选择 C/P 统计窗口；合并日晚于采集日时，不会自行按合并日重新计算另一批未经审核的 C/P 结果。每个来源的 `retrieved_at`、`data_as_of` 和原始窗口仍单独保留，不拿本轮操作时间补造来源时间。

单个来源失败、未修改或禁用时保留有效 last-good，并在操作报告记录这次尝试。整轮排名采集都失败且已有输入时，保留原 cohort，包括原评价日期。相同内容复用经认证的旧 envelope，不只为生成新 nonce 制造资料变更。

候选打包前再次校对 commit、工作区和排名文件 hash。`whole_bundle_validated=true` 还必须通过受信 `readRelease` 的 schema、revision、catalog 路径、字节 hash 与 size 校验，并确认：

1. `models-dev.code_commit` 等于计划中的上游输入。
2. catalog／manifest 使用计划的固定审核时钟与 sequence。
3. `reports/rankings.json` 的输入 hash、评价日期与加密 cohort 一致。

仅有一个形式正确的 revision 字符串不能宣称整包通过。这个状态表示整包完整性及输入绑定通过，不代表来源公开分发授权、首发覆盖门槛或生产发布资格已经通过。

## 需要人工审核的代码变化

如果候选改变 `packages/core`、依赖／锁文件、Bun 版本、根运行配置，或本地执行代码等输入，流程标记 **`manual_upstream_review_required`**，跳过持有解密 key 的构建，保留可审查的完整上游提案。候选仍可作为 draft PR 审核，但 `whole_bundle_validated=false`。

该门禁包含 `bunfig.toml`、tsconfig／jsconfig、`.env*` 等运行配置。普通构建失败则标为 `build_failed`；没有变化则标为 `unchanged`，不生成新的候选 PR。失败、跳过和待审核均不记为 PASS。

主分支已经前进时，写任务跳过过期提案；已有同仓库的每日／旧上游／旧 OpenRouter 数据审核 PR 未合并时，只保留本轮采集报告，不再推第二个候选，也不改写已有分支。新候选分支使用精确 commit 派生名称，发现同名分支内容不同时拒绝覆盖。流程不使用 force push，不自动合并 PR。

## 加密输入与秘密边界

提交到审核 PR 的统一输入是 `cogine/data/rankings.json`，格式为 `modelspage-ranking-input/aes-256-gcm/v1`。明文快照和目录在 AES-256-GCM 认证加密内；外层仅有 hash、nonce、tag、ciphertext 和受限审核元数据。审核元数据只包含日期、策略 ID、来源状态／数量／完整性／原生时间／使用状态，不含模型得分或原始指标行。

主代理已配置的三个 repository secrets：

| 名称 | 用途与步骤 |
| --- | --- |
| `MODELSPAGE_AA_API_KEY` | 仅受信排名采集 |
| `MODELSPAGE_OPENROUTER_API_KEY` | 仅受信排名采集 |
| `MODELSPAGE_INPUT_ENCRYPTION_KEY` | 项目专用 32 字节 hex key；受信采集加密／seed、受信审核构建，以及合并后的受信生产 build 解密 |

真实值不写入仓库、命令参数、PR、日志或测试 fixture。本地变量名示例在 [daily.env.example](../config/daily.env.example)，真实值只进入忽略文件或受信环境。写入 PR 的任务不持有这三个 key；普通 PR／fixture CI 不取得输入解密 key。生产 R2 写凭据仍只在原有最终上传步骤出现。

Actions artifact 使用明确文件允许列表，只上传：

- 加密 `rankings.json` 与安全 `collection.json`。
- 精确候选 `proposal.bundle`、加密输入、`plan.json` 和白名单化 `review.json`。

不上传原始 state、AA/OpenCode 原始数据、明文 catalog、private build 或其日志。当前 artifact 保留期为 7 天。Git bundle 只包含公共上游变化及加密输入；source key 不在 Git tree 中。采集和构建只执行目录／资料 GET 与离线处理，不调用模型推理。

## 真实 Bun preload 问题及修正证据

同伴复查使用固定 Bun 1.4.4 的临时无密钥 fixture 发现：即便入口是绝对路径的受信 CLI，只要 cwd 位于候选目录，候选 `bunfig.toml` 的 `preload` 仍可能先执行。单靠“绝对路径入口”不足以隔离候选运行配置。

修正后，所有带 key 的 Bun 步骤始终在 `trusted` cwd，显式使用受信空 Bun config，并关闭自动 dotenv。无 key 的同步子进程需要 candidate cwd，但同样固定受信 config／tsconfig，且剥除来源／输入／GitHub key 及 Bun／Node 注入选项。

真实 Bun 回归 fixture 在 candidate 中放入 preload 和 `.env`；受信 cwd 的带合成 key 调用及隔离后的同步调用都未执行候选 preload，也未加载候选 dotenv。该轮定向验证为 **15 项测试、149 个断言通过**，类型检查通过。

随后补强整包打包校验，加入完整 sealed v2 fixture、catalog 篡改、错误上游、错误输入报告和错误审核时钟的拒绝测试；最新定向结果为 **18 项测试、154 个断言通过**，类型检查与 `git diff --check` 通过。合成 fixture 的结构／完整性测试允许 `fixture=true`，不因此赋予生产发布资格。

## 复跑入口

PR #2 合并后，可以在默认分支手动运行统一入口；不需要再分别运行两个每日 workflow：

```sh
default_branch=$(gh repo view cogine-ai/modelspage --json defaultBranchRef --jq '.defaultBranchRef.name')
gh workflow run modelspage-collect.yml --repo cogine-ai/modelspage --ref "$default_branch"
```

旧上游手动入口会转调同一流程。运行记录中的 `daily-encrypted-collection` 和 `daily-review-proposal` artifact 提供安全审核元数据；查看 `plan.validation`、`whole_bundle_validated`、固定 commit／hash 与来源尝试状态，不把 artifact 存在本身当作构建或发布成功。

不使用 key、不访问来源 API的本地回归：

```sh
bun test cogine/test/daily-update.test.ts cogine/test/workflow.test.ts
bun run typecheck
```

本地资料采集接口为：

```sh
bun cogine/src/cli.ts collect-rankings \
  --state-dir .sync/rankings --out-dir .sync/proposal --now "$COLLECTION_TIME"
```

该命令应在已注入三个项目专用变量的受信 checkout 中运行，`COLLECTION_TIME` 使用本次真实 ISO 时间；不要把 key 放进参数。需要复现某个已有候选时，使用该运行的固定 `plan.published_at`、candidate tree 和加密输入，在 trusted cwd 执行受信 CLI 的 `build --root <candidate> --rankings-input <candidate>/cogine/data/rankings.json`。不要在带 key 的 candidate cwd 中直接运行 Bun，也不要用新的日历日期冒充原审核窗口。

## 合并后发布与当前授权状态

合并后仍走现有 reviewed-main 发布 workflow：确认当前 main 的精确合并 PR commit、受保护 production 环境和显式开关，固定发布计划、构建与验证，检查首发 C/P/N 和来源权利，再做不可变对象上传与 manifest 条件切换。输入解密 key 只加入受信生产 build，没有向 PR CI 或写入提案任务扩散。

生产发布保持关闭。此次接线没有把 AA/OpenCode 的公开用途设为已授权；当前配置为：

| 来源 | 采集状态 | 公开再分发状态 |
| --- | --- | --- |
| Artificial Analysis | `allowed`，内部资料输入 | `unverified` |
| OpenRouter 指定 Data API dataset | `allowed` | `allowed`，限已审查 dataset |
| Vercel AI Gateway 指定公开数据集 | `allowed` | `allowed` |
| OpenCode Go/Free | `unverified`，按明确请求用于内部诊断 | `unverified` |

这些是本仓库当前来源策略，不因下载成功、已配置 API key 或加密存储而被升级。加密解决私有审核输入的持久化，不替代公开发布许可；发布门禁继续阻止未授权事实进入对外分发。

## 主代理最终验证记录

真实内部采集完成：AA 715、OpenRouter 357、Vercel 1,406、OpenCode 596 条规范化观察。来源状态分别保留真实抓取时间与原生 data_as_of；额外重跑时 AA/Vercel/OpenCode 为 not_modified，沿用原 last-good 字节和时间，OpenRouter 检出原生数据变化。当前 C/P 固定 UTC 窗口是 2026-10-20 至 26（评估日 27），不会在 PR 合并时重新滚动。

固定生产 pin 仍为 `4f1231e6bf72d5fa66dc1163599eaaedb607faab`。实际正式 builder 用同一加密输入产出 catalog v2：11,881 条稀疏公共身份事实（内部候选），其中 C 6,733、P 3,304、有效日精度 N 11,855；这是 Provider × 请求 ID × 协议身份数，不是独立基础模型。候选 JSON 约 35.8 MB（实际字节数在构建 manifest 与本地收据内）。完整 schema/revision/hash/size 校验通过，本地 CAS dry-run 先 published、重复 unchanged；这是本地模拟，没有外网发布。直接公开资格检查按预期拒绝 AA 许可未确认，未报告为上线 PASS。

全量 CogineWork 诊断：固定来源 HEAD `f06181cbc864bdc3938d45920a86a5724fdd1c48`，39 项全部遍历，18 目录成功、2 缺专用认证、Kimi 国际站 TLS 失败、14 不支持通用目录、3 本地及 1 OAuth 未执行。取得 2,061 个来源 ID、1,985 个远端协议投影；共 2,217 条诊断记录，2,094 条客户端上下文、123 条来源补录。

| 事实 | 全部诊断行 | 客户端上下文 |
| --- | ---: | ---: |
| C | 660 | 632 |
| P | 320 | 294 |
| 有效 N | 1,486 | 1,418 |

P 1/2/3/7 日去重模型为 44/48/48/54。七日从上轮 56 变为 54，来自 UTC 窗口推进及来源/目录更新，不是恢复交集或添加齐全门槛。OpenRouter 目录本轮 +2/-6、Kilo +1/-1，全部精确 ID 与问题已记录。CogineLLM 仍为 128 个完整上下文：C 78、P 47、N 127。

最新 models.dev 仅作独立诊断参考：`8f6f1503f1082188e5fe150b3f36260f1169b9cf`，231 Provider/9,318 个 exact ID，10,628 个 archive blob 核对无差异；8,971 generator、347 raw_partial、332 兼容诊断保留，N-only 固定 parser 投影 295 条。与旧参考共有记录的日期变化为 0。它没有偷偷升级生产 pin，也不把部分解析记为全部 schema PASS。

对 2,217 行逐条独立重建 P/核 AA/N、完整成员集合及全局/Provider 总序，通过。再用真正每日 builder 的纯函数从认证加密 cohort 计算 808 个上游 canonical，逐条比对全部 1,146 个已关联 C 与 1,146 个 P 关联结果（含 unknown），与诊断报告完全一致；不是只挑几个模型冒烟。来源 hash、执行身份及 N 未被 C/P 关联改写。

最终本地验证：Bun 1.4.4；179 项测试、1,133 个断言，0 失败；typecheck 和 JSON schema 一致性通过。测试首次三项 stable tie 失败来自本轮意外调整了原 C/P 平局顺序；已恢复原规则，保留原目录位置的 N 语义并复跑通过。一次新测试的共享 fixture usage 对象造成连带撤销，已修正 fixture 深拷贝，真实数据逻辑未因此改变。

过程修正还包括：同 method 不同窗口/权重及 native/weighted 量纲不能混排；历史 P 可保留但超出当前 cohort 不再 eligible，旧 eligible 纠错需要更高修订；component 权限撤销压过旧 composite；catalog 成功不能冒充 ranking 成功；显式 disabled 停止请求；当前 usage 在持久化比较前应用，避免未变数据每天伪造新鲜时间；加密内容本身也做严格来源快照/目录校验。

本地证据位于忽略目录：`.modelspage/daily-integration-receipt.json`、`.modelspage/daily-cohort-verification.json`、`.modelspage/daily-real-repro-verification.json`、`dist/full-validation/verification.json`、`.modelspage/full-validation/runs/20261027T012325Z/receipt.json`、`.modelspage/daily-tests-final.log`。完整 HTML/CSV/JSON 是 `dist/full-validation/`。认证原始数据及明文候选没有提交公共仓库；公开 PR 只含代码、合成 fixture、加密输入和无分数审核元数据。

实现提交 `1f2bf674824ffae08d3ff43ab18458b02b8857aa` 的 [GitHub PR CI](https://github.com/cogine-ai/modelspage/actions/runs/40436243803) 已通过：179 项测试、1,133 个断言、typecheck、schema 一致性、fixture 构建与校验、发布 dry-run 均成功。同伴对该提交的每日权限／输入绑定链路作最终只读复核，没有新增阻断问题；这仍不替代合并后真实调度与生产验收。

三个 repository secret 的名称已通过 GitHub API 读回确认；不读回或输出值。当前工作在 draft PR #2，尚未合并。新的定时 workflow 及自动提案尚未在远端执行，必须待代码合并默认分支后生效。production 开关、DNS/证书/公开读取与外网发布均未执行。
