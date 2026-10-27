# 公网部署

本轮用户明确纠正交付目标是互联网网站，不能把本机 127.0.0.1 预览当作交付。延续已确认的网站基线，完成公网静态页面、排名数据、原 API 及正式子域名接入；DNS 记录最后统一交给用户配置。

## 来源授权记录

2026-10-28，向项目所有者明确询问 AA 与 OpenCode 是否已有“公开排名展示／JSON 再分发授权”，说明 AA 第三方排名/选模产品条款及当前仓库缺失记录。用户答复：**“有的，放心。”**

按这项直接确认将两处 redistribution 更新为 allowed。依据属于 **owner-attested**，不声称已独立阅览私人合同，也不要求用户将合同或密钥公开。原输入的历史 usage 状态仍保留在加密快照中；正式 builder 已用当前 source policy 覆盖适用的来源/profile，不修改观测值、权重或评估窗口。OpenCode 的 collection 记录继续保留原有未核实状态，这不撤销用户已确认的再分发范围；既有明确请求的采集流程不因该状态自动清空有效数据。

AA 的通用条款并非一概禁止外部引用：§2.3 允许署名的图表与短引用，§2.4/§2.5 的数据/排名产品限制由本次用户确认的专项许可覆盖。署名仍按适用条款保留。OpenRouter/Vercel 的指定数据集继续保留 CC BY 4.0 归属、来源时间和 Modelspage 转换说明；OpenCode 不标为 CC BY。

官方依据：[AA](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf)、[OpenRouter Data API](https://openrouter.ai/docs/cookbook/administration/data-api)、[Vercel](https://vercel.com/changelog/open-data-and-shareable-charts-for-ai-gateway-leaderboards)、[OpenCode Data](https://opencode.ai/data)。

## 平台与域名

使用独立 Cloudflare Pages 项目与自有 Pages worker，不恢复上游 SST 或遥测。既有专桶 modelspage-production 保留。Pages 支持外部 DNS 的自定义子域名，通过实际分配的 Pages hostname 做 CNAME；不需要整体迁移三个主域的 nameserver。

按前述候选优先准备 models.cogine.ai 为主地址，models.cogine.app 与 models.cogineai.com 可连接同一项目作为别名。最终 DNS 目标、实际平台状态和公网回读记录在本文件后续补充，不把候选值当已生效。

## 已完成的公网部署

- Cloudflare account `a11312197b2f8ff3e535b8c2f4ac9b22`，项目 `modelspage`，实际分配 `modelspage.pages.dev`；未修改其它项目。
- 初次部署 URL：`https://629c1a70.modelspage.pages.dev`；生产别名 `https://modelspage.pages.dev`。
- 已上传 1,220 个文件及自有 Worker。公开排名 revision `bf433662bb7e0b339cba6c4a35d4bef259abb71ce76d182dcaea5168069f141f`，614 模型，C199/P54/N612。P 仍为 UTC 2026-10-20～26；网站上线不冒充新观测。
- 公开 HTML、排名 JSON/schema、原三 API、multi-type 过滤、model-schema、实验 v2、MIT、AA Logo、分享 PNG 均公网 HTTP 200；只读跨域预检 204；未知页面404。真实浏览器已打开公网排名并加载图表。
- R2 `PUBLIC_DATA` binding 已配置，桶仍为空，`/v1/manifest.json` 实测 404，不将它冒充已发布。
- 205 tests /1,375 assertions 通过；两套类型检查、原 schema 与新增 schema 检查、目录 validate 及 v1 byte-identical 检查通过。PR #4 的完整 GitHub CI 也已通过。完整站点的公开准入在构建时执行，不上传 local-preview 候选。
- 代码重建与当前公网 JSON 已逐字节对比：事实不变时，保留现有 revision、published_at 与 evaluated_at；真正事实变更才生成新版本。浅克隆构建会显式获取固定上游 commit，不依赖本机 Git 对象缓存。
- Cloudflare Git 来源已连接 main，生产构建 secret 已配置（只记录名称），主分支自动部署开关已开启，预览部署关闭。合并后的真实构建结果另以平台 deployment 记录及公网回读验收；开关本身不当作自动发布成功。

首次 CLI 上传在配置校验阶段发现 Pages 不接受 `account_id` 字段，已移除并使用调用时 `CLOUDFLARE_ACCOUNT_ID` 明确账户；该次未部署。Worker compatibility date 固定为 2026-10-01，避免把台北当前日当成平台 UTC 的未来日期。没有迁移任何 nameserver。

## 主分支自动构建验收

PR #4 已合并至 main `0a933ffb13b1d4ca73c299daef6f9eb79b2669ab`，完整 GitHub CI 通过。Cloudflare 收到真实 `github:push` 触发，固定 Bun 1.4.4、frozen lockfile 与加密输入的公开构建成功。

首次 Git 部署 `db44069b-7a53-416d-9ed1-06c6e9475453` 在上传前失败：此前 CLI 上传把云端 output directory 写为相对于 `cogine/web/wrangler.jsonc` 的 `../../packages/web/dist`，Git root 为空时该路径越出仓库。已将云端构建输出修正为根目录下的 `packages/web/dist`，重试 `081620b3-760d-4d76-903c-5f250f31a750` 于 UTC 2026-10-27 18:17:17 成功发布，URL `https://081620b3.modelspage.pages.dev`。后续手动 CLI 上传仍须核对是否改变云端构建路径与变量。

跨 macOS／Linux 回读发现上游目录枚举次序会影响新增 canonical 数据的数组与指标平局排序，已在自有投影入口按精确 canonical ID 固定顺序，原 Models 页面及原解析器不改。回归用例只反转上游对象插入顺序，要求全量输出相同；修复前失败，修复后通过。

独立 GitHub workflow `Publish reviewed Modelspage revision` 仍在原有 `MODELSPAGE_PUBLISH_ENABLED` guard 处拒绝运行；这表示版本化 R2 发布未启用，与本次 Pages 网站部署是两条流程，不把该 workflow 报为通过。

### 最终部署与重复构建

PR #5 已将目录枚举顺序修复接入 main `d2f6639511b3db8262ea7a5165f1a778d649f22f`；206 tests／1,376 assertions 与完整 GitHub CI 通过。真实主分支自动部署 `a5f8d005-9367-4362-9176-36c287c16a0d` 成功，恢复普通构建命令后重建 `08a8bf18-87f3-4175-bde2-ef27ce965fad` 也成功。两条部署 URL 与生产别名的排名 JSON 均 HTTP 200，完整字节 SHA-256 都为 `817bf4e011371ff2caedd9a26b4bb8e76a4c5f8161b2777282a80019d10ed29b`，公开 revision 都为 `47eb9794f9ad3f8a69cc4de6f0159499fe3e358bb6d7589be221b2eb0ed82d6c`，覆盖仍为614模型／C199／P54／N612。

另一个跨主机指纹差异已定位：固定 upstream pin 中 `providers/nearai/models` 同时有 `Qwen`（5条）与 `qwen`（2条）目录。macOS 大小写不敏感工作目录将它们合并，Bun 枚举时把 `qwen/qwen3.5-397b-a17b`、`qwen/qwen3.7-max` 变为 `Qwen/...`，进而改变 registry 和 P 组合证据指纹。没有改变模型名称、canonical ID、权重或实际分值。

用同一官方 Bun 1.4.4 容器验证：读取 macOS 只读挂载目录，9271行 registry 指纹为 `f0df926e56649d1d96489a3df2e0ed232654873bbd9f1acdf52a3b15f0fef5f9`；从 Git archive 在 Linux tmpfs 独立解压固定输入，同为9271行但指纹为 `9036610d92c723345f3ebbd8577737aa469e051f6983f70b1e2bf28fdc6a8448`，精确匹配 Cloudflare 原生 Git 构建。后者保留了正确 API ID，不对 ID 做统一大小写处理。正式发布使用原生 Linux Git 检出；本机大小写合并的解析结果不能当作精确 Provider ID 的完整验收。该调查未改上游解析器、模型文件或排序值。

一次性云端诊断只打印输入 hash，没有打印解封内容或密钥，已恢复构建命令 `bun install --frozen-lockfile --ignore-scripts && bun run web:release`。证据收据保存在本地 `.modelspage/main-web-deployment.json`、`public-web-repeat-build.json`；真实公网浏览器无 error／warn，截图为 `/tmp/modelspage-public-20261028/rankings.png`。

## DNS 交付

三处 custom domain 已在 Pages 登记，目前为 initializing／verification pending。目标来自平台实际分配，并非示例。

| 主域／DNS 管理平台 | 类型 | 主机名 | 值 | TTL |
| --- | --- | --- | --- | --- |
| cogine.ai／Spaceship | CNAME | models | modelspage.pages.dev | 300 或 Auto |
| cogine.app／Vercel | CNAME | models | modelspage.pages.dev | Auto |
| cogineai.com／DNSPod（实时 NS） | CNAME | models | modelspage.pages.dev | 300 或 Auto |

如已有同名 A/AAAA/CNAME，替换为上表的一条 CNAME，不与 A/AAAA 共存。无需修改整个主域的 NS。若平台提供 Cloudflare 代理开关，验证接入时使用 DNS only。用户配好后再验收三个域名证书、地址与 API，之后将主地址元数据切换为 models.cogine.ai；当前实际可用的公网地址是 Pages hostname。

本机 DNS 对 A 查询返回 198.18.* 代理地址，因此未将其当作公网记录证据；域名验证状态以平台 API 为准。NS 查询分别为 Spaceship、Vercel 和 DNSPod。

本地证据：`.modelspage/public-web-live.json`、`public-web-tests.log`、`public-web-validate.log`、`public-web-v1.log`。公网 URL 和平台部署状态不能由本地单测替代，以上均另行检查。
