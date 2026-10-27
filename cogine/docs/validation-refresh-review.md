# Provider 刷新脚本复查记录（2026-10-26）

本次检查覆盖 `inventory.py`、`refresh.ts` 和 `rank-sources.ts` 的采集边界。输出是本地诊断资料；没有发布生产资料、调用推理接口或读取用户私有 Provider 配置。排序来源脚本的问题交由其维护者处理，本页记录刷新脚本的修复和已执行证据。

## 已修正的问题

- 为 curl 增加首参数 `-q`，避免读取本机 `.curlrc` 改变请求行为。
- 认证头只经 stdin 传给 curl。响应正文及响应头在内存中处理，正文检查通过后才落盘；响应头只保留无秘密字段白名单。
- 明文或 JSON Unicode 转义形式回显当前验证密钥时，拒绝规范化，丢弃原文，只保存固定错误占位符。原始响应 hash 与 `stored_body_redacted` 标识保留，不声称占位符是原始输入。
- 原始响应按内容 hash 命名，每次尝试另存历史；失败、部分响应和认证错误不替换最后成功结果。曾在历史保留机制加入前发生的六次初轮瞬态故障另记于本地 `refresh/run-notes.json`，不重建未知的原始时间戳。
- 补齐嵌套及不同拼写的分页、截断、错误和非法完成标记；无法解释的下一页合同标为部分响应，不猜测请求。校对来源实际提供的 `total_count`，分页只允许原始 origin。
- 固定首次读取的 inventory bytes 及 hash，避免运行途中输入变化导致记录错误 hash。非法多行密钥只影响对应 Provider，不中断其他 Provider 的状态记录。
- 区分通用 SDK 的候选目录与完整目录网关：前者按 CogineWork 跳过缺失 ID，后者按其来源解析器拒绝损坏行。Gemini 先过滤生成能力，再选择首个符合条件的重复 ID；不把未支持的协议从原始 listed ID 证据中删除。
- OpenAI Response 只允许使用自己的验证密钥或明确的 OpenAI 验证密钥后备；地区、套餐间不复用密钥。

## 已执行验证

使用仓库固定的 Bun 1.4.4：

```sh
bun test cogine/test/validation-refresh.test.ts
bun run typecheck
```

11 项离线回归测试、49 个断言通过；类型检查通过。测试覆盖分页完成指示、重复 ID、精确 ID 语义、TokenDance/Gemini/Zen/Go 协议投影、密钥作用范围及单 Provider 配置错误隔离。测试不访问外网，也不读取 `.env.validation`。

另外使用本地隔离的假 curl 做了六种响应回归：成功、明文密钥回显、Unicode 转义密钥回显、未知嵌套分页、`total_count` 不足及 HTTP 503。检查了 argv 不含密钥、stdin 正确传递认证头、Set-Cookie 不落盘、原始响应与历史不含密钥、部分及失败响应不改变最后成功文件。临时复现实验保留在忽略目录 `.modelspage/full-validation/self-review/`；首次隔离启动配置失败的尝试也保留，不能作为通过证据。

对七个成功 Provider 的现有原始响应做了离线重放，修正后的脚本仍得到相同的 1,161 个 listed ID 和 1,100 个客户端投影模型。另用 CogineWork 的纯 Go 目录解析器重放同一来源字节，得到相同的 38 个 listed ID、19 个投影模型。该解析器仅依赖标准库；没有导入应用或读取用户目录。重放使用 `python3 -B` 时可避免产生字节码缓存。

经授权仅用专用 OpenRouter 验证密钥重跑其目录 GET，HTTP 200，`total_count = listed = projected = 466`。这是认证目录观察，不是推理、额度或账户模型使用资格验收。其余 Provider 的匿名观察保持原状。

## 验证范围

`inventory.py` 通过静态 AST 和公开源码数据提取 39 个内置 Provider；27 个实际读取的来源文件与固定 CogineWork HEAD 内容相符。没有执行应用代码、读取 `OLLAMA_HOST`、凭据目录或用户自定义连接。

客户端协议投影是基于固定源码的诊断重现，不能替代安装版客户端工作流验收。公开目录成功也不能扩大客户端成员、改写执行 ID 或授予账户资格。本地三个 Provider 和 Codex OAuth 目录未执行采集。
