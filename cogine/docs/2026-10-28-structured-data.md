# 网站结构化数据

本轮使用 schema 技能检查现有公开站点。模型目录、排名与 Data 页原先均没有 JSON-LD。只增加机器可读标注，不增加可见文案、修改目录或改变 C/P/N。

## 页面映射

| 页面 | 标注 |
| --- | --- |
| `/`、`/models/` | `CollectionPage` → 无序 `ItemList`，包含真实 canonical 模型身份与详情链接 |
| 模型详情 | `WebPage` → `Thing`，使用精确模型 ID、名称与详情 URL |
| `/rankings/` | `CollectionPage` → 当前指标的有序 `ItemList`，并关联排名 `Dataset` |
| `/data/` | `CollectionPage` → `DataCatalog` → 模型目录与排名两个 `Dataset` |
| 下载 | `DataDownload` 指向 `/catalog.json?type=all`、`/rankings.json` 的实际 JSON 字节 |

其他页面获得同一正式 origin 的 `WebSite`、发布者和 `WebPage` 基础标注。模型 URL 分段编码，身份大小写、版本与标点保持不变。没有将模型当作商店商品，或把能力、热度分数变成用户评价和星级。

排名默认标注 P 已知成员的前30条，`numberOfItems` 是该指标已知总数，C/N 兜底成员不能获得 P 名次。客户端切换 C/P/N、搜索、筛选和显示更多时，标注与实际可见成员同步；比较图使用 C/P 均已知的无序交集，不宣称名次。真实零值保持已知，unknown 不补零。

数据集描述概括现有页面和下载内容。模型目录注明上游创建者、固定 commit 与原 MIT 许可；Modelspage 创建的聚合排名用 `isBasedOn` 保留各来源，不向它转授统一 MIT 许可。排名 `version`、`dateModified` 使用已经发布且无变化时保留的 revision／时间；目录不把 `retrieved_at` 当修改时间，整个 C/P/N 数据集不套用 P 的统计窗口。manifest 是发现元数据，没有冒充可下载 catalog。

## 验证

- 935个实际渲染页面逐页解析 JSON-LD；移除新增脚本后的 HTML 与修改前逐字节相同，排名 JSON 完整 hash 也相同。
- Schema.org Validator 对完整617模型目录、默认排名和两数据集图验证；补充创建者后的最终三类页面均为0错误／0警告。
- Google Rich Results Test 识别两个有效 `Dataset`；补充真实创建者信息。聚合排名没有统一公开许可声明，保留可选 `license` 的非严重提示，不为消除提示编造许可。
- 浏览器实测：P54／C200／N615；前30条、显示更多60条、搜索 DeepSeek 的22条，以及比较图41点，JSON-LD 与实际结果一致。
- 本项目217项测试／1475断言及两套类型检查通过，覆盖已知／未知、真实零值、来源许可、版本时间、URL 编码、可见切片及 `</script>`／Unicode 安全序列化。JSON-LD 同时用于静态 HTML 和客户端更新。

构建验证还发现固定 Bun 1.4.4 下旧 `web:build` 的 `bun --cwd packages/web run build` 仅打印帮助、退出0；改为 `bun run --cwd packages/web build` 并实际生成页面，使 CI 的该步骤执行真实构建。生产发布原本直接调用构建文件，此处没有更换部署架构。

最终测试、Google 测试链接和合并后的 Pages／版本化发布、三域名回读结果记录在关联 PR。上线不代表 Google 已收录或保证富结果。

## 官方依据

- [Google Dataset](https://developers.google.com/search/docs/appearance/structured-data/dataset)：名称、描述、创建者、分发与来源。
- [Google 结构化数据通用准则](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)：内容必须与用户实际可见内容相符。
- [Schema.org ItemList](https://schema.org/ItemList)：有序列表使用 position，分页可保留完整 numberOfItems。
- [Schema.org DataCatalog](https://schema.org/DataCatalog)、[Dataset](https://schema.org/Dataset)、[DataDownload](https://schema.org/DataDownload)：数据集目录与实际下载的关系。
- [Google Carousel](https://developers.google.com/search/docs/appearance/structured-data/carousel)：模型目录 ItemList 不承诺专用模型轮播富结果。
