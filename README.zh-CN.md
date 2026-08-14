# MCode Plugins

[English](README.md)

MCode Plugins 是面向 MiniMax Code 的社区插件索引与贡献工具集。插件作者继续在自己的 GitHub
仓库中维护源码、Issue、License 和发布节奏；本仓库只负责可检索索引、固定 commit 的可审查提交格式、
离线校验、兼容性说明和统一贡献流程。

> 当前状态：社区预览。插件进入索引，只代表其固定 commit 通过了自动兼容性检查；不代表 MiniMax
> 背书、完成安全审计或提供可用性保证。

## 为什么不是一个巨型插件仓库

一个真正能运转的生态，需要打通完整链路：

```text
创作 -> 校验 -> 提交 -> Review -> 发现 -> 安装 -> 反馈 -> 维护
```

本仓库采用“作者自持源码 + 中央索引”的方式：

- 作者保留插件仓库、Issue、License 和版本的所有权；
- 索引固定完整 Git commit SHA，Review 和安装对应同一份不可变源码；
- CI 校验 MCode 实际支持的能力，不根据 README 名称猜测兼容性；
- 能力与安全元数据在安装前展示依赖、可执行程序和网络访问；
- 插件问题回到作者仓库，索引规则与治理问题留在本仓库。

## 首版公开契约

首版只承诺已经有稳定 Runtime ownership 的能力：

- 根目录 `plugin.json`，遵循 [Agent Plugins 1.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)；
- `skills/<skill-name>/SKILL.md` 下的 Agent Skill；
- 可选的 `mcp.json`，支持 `stdio`、`streamable-http`、`sse`。

目前不把 Plugin Hook、自定义 Agent、Command、LSP、App、通用 OAuth 或任意 `extensions`
宣传为 MCode 能力。跨客户端插件可以包含这些内容，但索引只描述 MCode 实际可加载的部分。完整边界见
[兼容性说明](docs/plugin-compatibility.md)。

## 创建并提交插件

从 Skill-only 的 [`examples/hello-mcode`](examples/hello-mcode) 或无第三方依赖的 stdio
[`examples/hello-mcode-mcp`](examples/hello-mcode-mcp) 复制一个最小可用包，把插件放在自己的公开
GitHub 仓库，然后在本仓库运行：

```bash
npm install
npm run add -- https://github.com/you/my-plugin --path optional/subdirectory
npm run check
npm run verify -- registry/my-plugin.json
```

生成器会固定默认分支当前的 commit，读取插件能力并生成索引草稿。提交 PR 前，请人工核对分类、运行依赖、
网络访问和安全说明。详细要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 信任边界

索引里的插件仍是社区代码。使用前应阅读源码和能力声明，不要在 `plugin.json`、`mcp.json`、Skill 或索引
条目中直接写入凭证。插件可能调用本机可执行程序或远程服务，其依赖和服务质量仍由插件作者负责。参见
[SECURITY.md](SECURITY.md) 和 [安全模型](docs/security-model.md)。

## License

索引工具与文档使用 Apache-2.0。外部插件保留各自的 License；被索引不会改变插件原有授权。
