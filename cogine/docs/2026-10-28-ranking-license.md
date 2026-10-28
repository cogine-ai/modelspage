# 排名数据集的版本化来源许可

按项目所有者要求，增加独立的[来源许可说明 v1.0](../web/licenses/rankings-v1.0.txt)，公开路径为 `/licenses/rankings-v1.0.txt`。文件用于说明 canonical C/P/N 排名各来源的适用许可，不向现有页面增加文案、链接或其他可见元素。

## 来源与范围

| 成分 | 本版本记录的适用范围 |
| --- | --- |
| models.dev 目录／发布日期 | 原 MIT 许可，保留版权、许可和免责声明；引用固定上游 LICENSE |
| OpenRouter rankings-daily | 指定 Data API 聚合数据的 CC BY 4.0；按 endpoint 要求保留来源、as-of 时间、许可与修改说明，不扩大到无关 API |
| Vercel AI Gateway leaderboard-export | 公开榜单数据 CC BY 4.0，保留署名、许可链接和修改说明 |
| Artificial Analysis 能力观测 | 已确认的项目公开展示／JSON 再分发授权；保留 AA 署名、适用图表 logo、指标配置和非背书说明，不把项目专属授权转授给所有接收者 |
| OpenCode Go／Free 观测 | 已确认的项目公开展示／JSON 再分发授权；保留 OpenCode Data 来源及源更新时间，不套用其软件许可或 CC BY |

AA 的公开核对依据为 Data Platform Terms v1.1（2026-08-19），OpenCode 通用条款生效日为2026-08-15。专项协议可能提供不同范围，文件没有用一般条款撤销本项目已确认的授权，也没有要求公开私人合同。项目授权记录仍见[公网部署记录](2026-10-28-public-deployment.md#来源授权记录)。

组合文件没有将所有数据统一改授 MIT 或 CC BY，也不为这些已开放成分新增限制；接收者已独立取得的许可、适用协议和法定权利继续有效。Modelspage 的身份关联和60／30／10加权属于转换说明，不会扩张上游授权。

## 标注与交付

排名 Dataset 的 `license` 使用 Google 明确支持的自定义许可形式：

```json
{
  "@type": "CreativeWork",
  "name": "Modelspage Rankings Data Terms v1.0",
  "version": "1.0",
  "url": "https://models.cogine.ai/licenses/rankings-v1.0.txt"
}
```

该节点同时用于 `/data/`、`/rankings/` 及客户端实际加载数据后的更新。模型目录 Dataset 继续引用原 `/licenses/models-dev.txt`，DataCatalog 不被误标为统一许可。

路径、名称、版本在纯模块中共享；文本作为真实静态文件经 `siteAssets` 分发，不向浏览器引入 Node 文件读取依赖。以后修改条款使用新的版本化 URL，保留已经发布的版本。

## 上线前验证

- 935个实际渲染页面去除脚本后的 HTML 与修改前逐字节一致；`rankings.json` 字节未变。
- 本项目218项测试／1491断言、两套类型检查通过；覆盖原目录 MIT、自定义许可、SSR／动态标注一致性与真实静态文件。
- 真实网页构建后，本地 GET 独立文件返回200、`text/plain`，内容与版本化源文件逐字节相同。
- Schema.org Validator 对 Data 与 Rankings 两图均为0错误／0警告。
- [Google 代码测试](https://search.google.com/test/rich-results/result?id=xqJeBh4WYS3xIlrmxP85mA)识别两个有效 Dataset，不再显示缺失 license 的非严重提示。

合并后的自动部署、版本化发布、三个正式域名文件／标注回读及 Google 公网 URL 复测记录在关联 PR，避免把代码测试当作公网抓取验收。

## 核对来源

- [models.dev 固定 LICENSE](https://github.com/anomalyco/models.dev/blob/dde15ad9b8c0903ea4e26da44e637c4fd880e9a9/LICENSE)
- [OpenRouter Data API](https://openrouter.ai/docs/cookbook/administration/data-api)
- [Vercel 开放榜单数据说明](https://vercel.com/changelog/open-data-and-shareable-charts-for-ai-gateway-leaderboards)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [AA 数据文档](https://artificialanalysis.ai/data-api/docs)、[Data Platform Terms](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf)
- [OpenCode Data](https://opencode.ai/data)、[服务条款](https://opencode.ai/legal/terms-of-service)
- [Google 自定义 license 定义](https://developers.google.com/search/docs/appearance/structured-data/dataset#license)
