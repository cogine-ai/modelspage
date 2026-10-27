# 网站品牌与上游来源

用户确认保留原网站功能、独立扩展排名与数据集后，本轮修正本站身份和资源，未改 C/P/N 规则、目录成员或执行模型 ID。原有未提交工作保留。

## 名称与资源

| 位置 | 处理 |
| --- | --- |
| 默认及模型/Provider/Lab 的 title、description | 本站名称改为 Modelspage |
| Header | 保留 Modelspage 标题和原导航，去掉多余介绍口号 |
| 帮助中的 API / logo 示例 | 从对方域名改为当前浏览器 origin；链接和 curl 显示地址一致 |
| 贡献入口 | 指向 cogine-ai/modelspage；明确 TOML 指模型目录 |
| 原 SDK 说明 | 保留为 Upstream SDK，明确是 models.dev 的 typed catalog/upstream snapshot，不冒称本站排名 SDK |
| favicon / 社交分享图 | 使用新写的本站页签符号和 Modelspage 字标；新 PNG 1200×630 从自有 SVG 导出，上游原图不分发 |
| OG / Twitter 分享图 | 采用本站 /social-share.png；正式构建的绝对 origin 由 MODELSPAGE_WEB_ORIGIN 配置，本地预览使用当前 origin，不猜测最终域名 |
| 源码归属 | 帮助底部、Data 页使用简短 Based on models.dev · MIT License |
| 真实来源 | 保留价格/日期来源、AA/OpenRouter/Vercel/OpenCode 来源标签和证据 URL |
| Provider / Lab logo | 保留对应实际厂商/实验室标识，没有替换成本站图标 |
| 字体及内部名称 | Rubik/IBM Plex Mono 的 Google Fonts 请求不是 models.dev 热链；保持字体。内部 @models.dev/core 名称保留 |

当前本地预览未使用上游 SST/worker 部署链；归档或未启用的上游域名/遥测代码不能当成当前页面在使用的资源，本轮未恢复它们。

## MIT 通知

以仓库导入的实际 `LICENSE` 为准，保留 `Copyright (c) 2025 models.dev` 和 MIT 全文。MIT 的条件是复制或分发软件的全部或实质部分时包含原版权声明与许可通知；文本没有要求每个页面必须显示原 Logo、醒目背书或固定页眉。许可证正文也可在 [OSI MIT 文本](https://opensource.org/license/mit) 查看。

本轮把完整许可证生成到 `/licenses/models-dev.txt`（text/plain），且 JS banner 与 CSS legal comment 都含原版权和许可全文；不只保留在 Git 仓库而漏出网站分发物。简短的可见来源链接是我们选择的署名方式，不把它说成 MIT 强制的展示文案。不更改根 LICENSE 的原版权，也不推定第三方数据或标识的权利。

## 验证

- Bun 1.4.4：静态构建成功；931 个 HTML 的本站标题均为 Modelspage，无旧站分享图热链或残留占位符。
- 构建后的 JS/CSS 包均保留原 MIT 全文；分发的许可证与根 LICENSE 字节一致；favicon 和分享 PNG 与新资产字节一致。
- 八类目录/详情/排名/数据页面 HTTP 200，title 与 OG 图片 origin 正确；许可证 HTTP 200、text/plain、正文一致，两个新品牌资产 HTTP 200。
- 浏览器验证帮助中四个示例均为当前 127.0.0.1:8183 origin，GitHub/来源/许可链接分别指向预期目标；帮助保留短来源署名。
- 两套类型检查通过；6 项已有 web 数据投影测试、28 个断言通过；目录 validate 通过，v1 相对固定上游 ref 输出 byte-identical。上一轮 185 项全套结果保留，本轮未将其冒充重新运行。
- 模型/C/P/N 覆盖仍为 614 / 199 / 54 / 612，来源窗口和数据日期未改成当前日期。

本地证据：`.modelspage/web-brand-artifacts-20261028.json`、`web-brand-http-20261028.json`、`web-brand-validate-20261028.log`、`web-brand-v1-20261028.log`；浏览器截图在 `/tmp/modelspage-brand-20261028/`。未上线或发布到外部应用。
