# Legacy 普通字段：实现与本地验证

日期：2026-11-07（Asia/Taipei）。分支 `cliq/legacy-catalog-field`，基于 `51fcb87bcf8f504ffe0dc4769fcd1a040d96ddc9`。以下记录发布前已完成的本地验证，不替代 Linux CI 或生产回读。

## 交付

- 模型 catalog 表格末尾增加普通 Legacy 列，显示 Yes/No，不可点击排序；保留原 Updated 默认降序。
- 模型详情在既有 Facts 区、Updated 之后增加 Legacy 属性，不修改标题、名称、链接、搜索词或展示优先级。
- 不增加徽标、筛选、分组、折叠、默认选模或调用变化。Rankings 与版本化 C/P/N 数据结构保持原样。
- 唯一名单为 [`legacy-models.json`](../config/legacy-models.json)：673 个具体共享版本、1,255 条完整协议服务覆盖项。与此前完整配置预览字节一致，不带审核字段。
- 公开目录通过 `include=legacy` 显式扩展，适用于 `/catalog.json`、`/models.json`、`/api.json`。默认 JSON 保持兼容，扩展 schema 为 [`catalog-legacy.schema.json`](../schema/catalog-legacy.schema.json)，附合成正反例。没有新标签服务或发布流水。

## 已执行验证

全部使用本地固定 **Bun 1.4.4**，没有使用系统默认的 1.3.6 冒充固定版本。

| 检查 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | PASS，182 installs / 194 packages，无依赖或锁文件变化 |
| `bun run typecheck` | PASS |
| `bun run typecheck:web` | PASS |
| `bun run schema:check` | PASS，旧 C/P/N schemas 未变 |
| `bun run test:cogine` | PASS，241 tests / 0 fail；覆盖普通属性、精确协议和 false 例外、旧合同、缓存隔离、重复 type、条件 GET、HEAD |
| 网站本地 `web:build` | PASS，使用 local-preview 模式，无生产输入/发布 |
| Pages worker browser-target bundle | PASS，6,695 bytes |
| `bun validate` | PASS，上游模型资料未修改 |
| `bun run v1:check 2055f95b2f24f679b0d3eb2cfb222fad488e332f` | PASS，所有 v1 视图字节一致 |

真实构建产物另行通过扩展 schema 校验。当前原生 v1 全类型视图是 **618 份共享型号、9,004 条 provider 记录**；其中 511 份共享型号为 legacy。没有为了展示配置中的 673 项而把原先 v2-only 的型号加入 v1。删除扩展产物中新增的 legacy 字段后，整个 catalog 与原始产物 JSON 字节一致，含记录次序及其他全部字段。

## 页面与 HTTP

本地预览仅监听 `127.0.0.1:8197`；使用缓存的 Chromium 进行真实页面验证：

- 桌面 1600×1000：Gemini 2.5 Pro 详情显示 Legacy Yes，Gemini 3.8 Flash 显示 No；主目录原有 14 列顺序不变，仅末尾追加普通 Legacy 列。
- 末尾 Legacy 列可沿原页面横向滚动访问，没有改变原滚动容器或样式。
- Legacy 与 Updated 的字段标题均为 **11px、font-weight 400、rgb(153,153,153)**，与其他普通属性一致。
- 手机 390×844：详情属性可见，沿用原有属性排版。
- 浏览器请求默认目录时没有 legacy 属性；显式请求得到原有成员和正确布尔值，包含 Anthropic Opus 5 限定服务判断。
- 浏览器 page errors 为 0。检查记录与桌面/手机截图保存在 ignored `.modelspage/legacy-field/`，没有进入公开站点产物。

只验证了本机 macOS 的本地构建与浏览器，以及 worker 的本地测试/打包；未执行 Linux CI、生产域名请求、Cloudflare 部署、真实账户认证、模型推理或 CogineWork 接入。上游已有 Qwen/qwen 大小写目录差异仍需按现有 Linux 发布流程验收，本次未改变其处理方式。
