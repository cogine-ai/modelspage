# 每日更新首次远端验收（2026-10-27）

本次目标是更新两处过时说明、合并 #2，然后真实运行每日采集到自动审核 PR 的链路。**自动提案链路通过；新上游候选尚未整包验收，候选 CI 有两项失败，未合并或发布。**

## 合并与触发

- 文档提交 `5c567d5e37c1f5231949d2f0678a307fbe9c4d7f` 更新 README 的 P 加权并集口径、Provider 当前凭据需求，并在验收记录中注明自动创建 PR 权限已解除。
- 组织及仓库 `/actions/permissions/workflow` 均读回 `can_approve_pull_request_reviews=true`，默认 token 权限仍为 read。
- 该提交的 [PR CI 40454723405](https://github.com/cogine-ai/modelspage/actions/runs/40454723405) 成功后，[PR #2](https://github.com/cogine-ai/modelspage/pull/2) 合并为 `f5db533791b4eb6df8408dbdffa65a5d686be08d`，本地 main 只作 fast-forward 同步。
- 手动 dispatch main 上的 `modelspage-collect.yml`，得到 [每日运行 40454899092](https://github.com/cogine-ai/modelspage/actions/runs/40454899092)。台北时间 **13:21:55–13:22:51**，collect、prepare、propose 均为 success。

## 真实采集及固定候选

| 来源 | 本次尝试 | 有效观察数 |
| --- | --- | ---: |
| Artificial Analysis | not_modified，保留 last-good | 715 |
| OpenRouter | success，内容变化 | 357 |
| Vercel AI Gateway | success，内容变化 | 1,406 |
| OpenCode Go/Free | success，内容变化 | 596 |

OpenRouter、Vercel 身份目录均为 not_modified。真实加密输入已在本地通过认证解密和严格校验；AA 的旧快照字节及抓取时间完整保留。评价日仍为 2026-10-27，七日窗口为 UTC 10 月 20–26 日；60/30/10 权重及并集政策未变。

采集工件只含 `collection.json` 和加密 `rankings.json`；提案工件只含 `plan.json`、`review.json`、`proposal.bundle` 和同一加密输入。两份输入字节一致，SHA-256 为 `a5795bee027f3d74738beebb16d0dde92239d952a002679222e9d1ead6a9aaeb`；认证明文 hash 为 `1d70be8b8ebdd8e183d321384607569b02be7192b04ccbc5d1ab43a2eb278d78`。检查中没有输出明文分数或凭据；输入及审核元数据对 16 个已配置秘密变量作内存比对，命中数为 0。

候选为 `a90d71a8f1fcdab71841cbd9473ae2a30be8725f`，固定上游为 `dde15ad9b8c0903ea4e26da44e637c4fd880e9a9`。已核对 Git bundle、实际远端候选、上游 ancestry、输入 hash 及保护文件差异；`.github/workflows`、README 和 AGENTS 没有相对基线漂移。上游工作流仍只是 `cogine/docs/upstream/` 内的惰性参考。

上游包含 21 个 `packages/core` 文件变化，包括 generator/schema。流程如实输出 `manual_upstream_review_required`、`can_build=false`、`whole_bundle_validated=false`，没有执行持有输入 key 的候选构建。完整变更清单在工件 `plan.json` 中。

## 自动 PR 与实际 CI

写权限作业使用 GitHub Actions 身份创建了唯一的 [Draft PR #3](https://github.com/cogine-ai/modelspage/pull/3)：

- 分支 `automation/daily-a90d71a8f1fc-f5db533791b4`，head 与计划中的候选完全一致。
- PR 正文包含准确 base、candidate、输入 hash 及人工审核状态。
- 已显式 dispatch [候选 CI 40454980395](https://github.com/cogine-ai/modelspage/actions/runs/40454980395)，实际执行 typecheck、schema 检查及测试；不是只发出了启动请求。

候选 CI 的 typecheck/schema 通过，179 项测试中 **177 pass、2 fail、1,117 assertions**；fixture 构建、校验及发布 dry-run 因此前测试失败而跳过。两项均位于 `cogine/test/validation-upstream-reference.test.ts`，只读对照候选源码后归因为旧 fixture 假设过时：

1. 第 25–33 行以 audio 类型制造语义失败，但新上游 translate 已明确允许 audio；测试预期该模型被隔离，实际模型合法生成。后续可用仍需要 `v2_only` 的 extraction 样例保留该语义失败覆盖。
2. 第 63–86 行的工具样例预期仅移除未知 `tools.search`。新 schema 已认识 search，但样例给的是错误类型，现有逻辑因此移除整个可选 tools 容器；日期继承、覆盖与 omit 的断言已先通过。后续可用明确未知的 fixture 专用字段保留单字段移除覆盖。

这两项尚未修改，不把失败记为通过，也不为兼容旧测试恢复过时的生产约束。#3 保留 draft；本次没有合并新上游。

另一个由 pull_request 事件形成的重复运行 [40454982049](https://github.com/cogine-ai/modelspage/actions/runs/40454982049) 为 action_required；没有将其计作 PASS，也未批准该重复运行。显式 dispatch 的 CI 已完整运行到实际失败点。

## 发布、平台提示与查看入口

合并 #2 同时触发 [生产发布运行 40454847722](https://github.com/cogine-ai/modelspage/actions/runs/40454847722)，它在首个显式开关检查处退出：`MODELSPAGE_PUBLISH_ENABLED` 未启用。生产 checkout/build/upload 均未执行；这不是部署成功。

Actions 还提示旧 action 的 Node 20 runtime 已由平台强制转为 Node 24、ubuntu-latest 正在迁移。这些是平台提示，本轮没有因此失败，也没有顺手升级 action。

目前可供人查看的是本地 `dist/full-validation/index.html`，可供 agent 读取的是同目录 `report.json`，评估时间仍为 2026-10-27T02:07:15.283Z；它们不是这次新上游候选的整包结果。本地静态服务使用 `127.0.0.1:8177`。继承的 `packages/web` 尚未接入本项目的新 C/P 与 manifest/catalog 协议；正式公网站点和公共 JSON 路径均未部署验收。

本次没有模型推理、私有账户目录访问、DNS 修改或生产上传。原始运行工件、认证校验收据和 CI 失败日志保存在忽略目录 `.modelspage/daily-remote-20261027/`。本记录只包含安全状态、公开运行链接和 hash，作为本地验收交付；自动生成的 #3 未被人工改写。
