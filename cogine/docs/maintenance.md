# 维护工作流

GitHub Actions 需要组织的 Selected repositories 允许列表包含本仓库。若运行长期 queued 且没有 job，先查看仓库 Actions 设置是否被组织策略禁用，再核实组织允许列表。不要只凭 queued 推断 runner 容量不足。自动上游/数据 PR 还需要组织允许 GitHub Actions 创建 PR；这个权限与只读 CI 分开配置，不应为验证 CI 自动开启。

## 初始化与上游同步

目标 `cogine-ai/modelspage` 在本次初始化前没有分支或 commit，本地目录为空。导入了 models.dev 完整历史，origin 指向本项目，upstream 指向上游；上游默认分支在导入时为 dev。准确输入与时间保存在 [`upstream.lock.json`](../upstream.lock.json)。没有强推、删除远端分支或引入 submodule。

`bun run upstream:sync --check` 从远端 HEAD 查询实际默认分支，抓取相应 ref 并报告是否已经合并，不修改工作区文件。`--merge` 要求本仓库、正确 origin 和干净工作区，在当前维护分支准备保留历史的 merge commit；它不会向 main 推送。上游新增/修改的 workflows 全部进入惰性归档，根 README/AGENTS 和活动 workflows 保留 Modelspage 版本。

建议维护者使用独立分支：

```sh
git status --short
git remote -v
git switch -c review/upstream-sync
bun run upstream:sync --merge
```

自动 workflow 在默认分支上准备同类变更，验证后直接推送完整 merge commit 到包含上游与基线 SHA 的 `automation/upstream-*` 新分支，再提交审核 PR；不重写或压平上游 ancestry，不向 main 直接推送。需要仓库允许 GitHub Actions 创建 PR。由 GITHUB_TOKEN 创建的 PR 通常不会自动触发新的 PR workflow，因此同步 workflow 本身先运行校验，再用 actions:write 显式 dispatch 该分支的 modelspage-ci.yml。分支已有时复用开放 PR，不强推。仓库必须允许相应 PR 创建与 workflow_dispatch 权限；失败会显示为失败，维护者可手动运行 CI。

若 merge 有非入口文件冲突，脚本保留 merge 状态并失败，绝不把未完成合并称为成功。先检查 `git status` 与 `git diff --name-only --diff-filter=U`。逐项合并上游变化和自有扩展，尤其 package.json/bun.lock；不能只选整棵 ours/theirs。同步代码、依赖或目录后更新 upstream.lock.commit 为已核实的上游 SHA，使用同版本 Bun 重建锁文件，并运行校验。若要取消，在确认需要保留的变更已经备份后使用 `git merge --abort`。

上游目录变更继续执行原贡献规则：`bun validate` 和 `bun run v1:check <同步前固定上游SHA>`；v1:check 的显式 ref 避免依赖已经不存在的 origin/dev。检查任何数据变化是否有来源、日期和兼容依据。导入的 sst.config.ts 仅保留历史，不运行其生产部署命令。

## 新增来源

1. 先核实公共接口、字段定义、统计窗口、完整性结束条件、认证、限流，以及采集/存储/公开派生结果各自用途。记录具体条款或授权，不能把一个接口的许可泛化到整个网站。
2. 检查上游采集器是否可复用。来源语义放入 `cogine/src/adapters/`，公共请求层复用超时、退避和缓存；不为每个 Provider 复制整套框架。
3. 准备明确标记的合成正反例，测试分页缺失、重复、总量变化、异常空集、失败和304。不把生产原始响应或凭据提交到 fixture。
4. 通过 PR 提交配置和使用条件。未确认发布许可的来源默认关闭；C 不用假分数填空。新的方法版本应新建 profile，不能混排旧方法分数。
5. 经审核的持久快照放到 `cogine/data/`；临时真实探测保留在忽略的 `.sync/`。不能由一次 --probe 自动开通生产。

## 映射、日期与纠错

映射、核验日期和纠错均在 `cogine/config/`，保存完整 scope、依据、审核者和时间。身份变更、人工纠错、撤回及方法变更始终通过 PR；不根据名字相似度自动发布关联。精确日期也必须证明对应的具体模型版本，而非只证明同名模型家族曾发布。

纠错可以替换为更早日期、声明 conflict 或 withdraw。撤回必须有递增 sequence 和明确依据；不要删除 ledger，后续上游同步及随包默认不能复活旧事实。异常大量删除或空榜作为需审核状态，保持最后有效版本。

普通已验证来源的数据更新可以逐步自动化，但仍必须有完备校验与可审计输入。每日采集 workflow 先以只读权限生成审核工件。只有已审查配置同时允许采集与再分发、获得完整且变化的成功快照时，才启动独立写权限任务，把该快照提出数据 PR并显式 dispatch CI；默认禁用配置、304/相同内容、失败和部分结果不会提出数据 PR或触碰生产。

## 覆盖和状态

每次 build/coverage 生成 Provider/字段矩阵与来源状态报告，统计输入来自当前固定上游目录，未使用 CogineWork inventory，因此没有硬编码历史 Provider 数量。

- **已支持**：结构/adapter/字段处理已实现；不能据此推断账户可调用。
- **未覆盖**：本构建没有足够已核验证据。
- **需认证**：来源确实要求认证但公共构建没有相应权限；不会假造认证成功。
- **无公开来源**：配置或已有证据明确没有可用于公共分发的来源。
- **未验证**：存在候选资料但日期适用性、指标比较性、逐项热度覆盖或使用条件尚未核实。

报告应结合每个字段的有效事实数阅读；“支持数据合同”不等于“能力榜可运营”。真实联网探测、认证、推理、R2 写入和公开域名验证必须分别列结果。README 中的命令、目录和状态随实现更新。
