# Open Artifacts ![](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)

[English](README.md) | **简体中文**

开源自托管的 [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts)：
让任意编程 agent 把自包含的 HTML/Markdown 页面发布到可分享的 URL，用密码（零知识、客户端加密）保护，
并在它所描述的项目演进时保持更新。运行于 Cloudflare（Workers + D1 + R2，Live 可选 Durable Objects）。
中立引擎支持 capability token 与可注入 `Authorizer`；加固后的生产配置以私有团队为边界并默认 fail closed。

> **托管或自托管。** [coda0.com](https://coda0.com) 是由项目官方运营的托管实例——
> 把你的 agent 指向它即可零配置发布；也可以在自己的 Cloudflare 账号上自托管这个引擎
> （见下文），两者是同一份 MIT 许可的代码。

```mermaid
flowchart LR
  you["你"] -- "把 app 的交互流程分享成一个页面" --> agent["你的 agent"]
  agent -- "POST /api/artifacts" --> worker["你的 Worker"]
  worker -- "https://<instance>/a/3fKx9mQp2Wvb" --> url["可分享的 URL"]
  later["之后：流程变了"] --> status["agent 运行<br/>artifact.mjs status"]
  status -- "stale" --> regen["重新生成页面"]
  regen -- "PUT（同一个 id）" --> worker2["你的 Worker"]
  worker2 -- "同一个 URL，v2" --> url
```

## 给你的 agent 装上技能

```sh
npx skills add coda0HQ/open-artifacts -s using-open-artifacts   # 项目作用域（.claude/skills/）
npx skills add coda0HQ/open-artifacts -s using-open-artifacts -g  # 或用户作用域
```

兼容 Claude Code 以及任何支持
[Agent Skills](https://agentskills.io) 标准的 agent。然后把它指向一个实例——官方托管的，或你自己的：

```sh
export OPEN_ARTIFACTS_URL=https://coda0.com   # 托管实例，或你自托管的 URL
```

还没有实例？随技能附带的 `references/deployment.md` 列了三种获取方式：零配置使用公共共享实例、
在自己的 Cloudflare 账号自托管，或共享一个团队实例，并附信任模型表帮助按内容敏感度选择。

随附的 `SKILL.md` 和 `references/design.md` 教会 agent 设计理念：专家设计师式的工作流
（理解、探索、规划、构建、验证），一份明确的反 AI 套路清单，现代 CSS 实用技巧，
以及一个 5 方向设计库（Editorial / Modern minimal / Human / Tech utility / Brutalist），
内附可直接粘贴的 OKLch 调色板和字体栈，用于未指定品牌时的情况。
`references/tokens.css` 是共享的 token 契约，Recipe 构建器会先注入它，再追加主题片段中的身份 token 覆盖。
改编自 [open-design](https://github.com/nexu-io/open-design)、Claude 的
`artifact-design` 技能、Paul Bakaus 的
[impeccable](https://github.com/pbakaus/impeccable)（Apache-2.0，交互状态与
反模式规则）、Emil Kowalski（缓动/频率/时长规则）以及 Apple WWDC 2018
*Designing Fluid Interfaces*（画布手势物理），重新适配本项目严格的禁止外部请求
CSP。

让你的 agent "把这个发布成 artifact"，它会运行随附的 CLI：

```sh
node skills/using-open-artifacts/scripts/artifact.mjs validate \
  .artifacts/recipes/app-interactions.recipe.json
node skills/using-open-artifacts/scripts/artifact.mjs create \
  .artifacts/recipes/app-interactions.recipe.json
```

每个 Artifact 都由版本化 JSON Recipe 和有序片段生成。Recipe 记录标题、favicon、
格式、scope、watch glob、channel、等级、Canvas 模式、本地性和加密策略。
`create` 与 `update` 在内存中组合并验证，最后只发送一次发布请求。

## 部署你自己的实例

```sh
git clone https://github.com/coda0HQ/open-artifacts && cd open-artifacts
pnpm install
npx wrangler d1 create open-artifacts        # 把 id 写进 wrangler.production.jsonc
npx wrangler r2 bucket create open-artifacts-content
pnpm check:environments                       # 校验 Preview/Staging/Production 隔离并 dry-run
```

部署前必须应用全部编号 D1 migration；生产请求只验证 Schema 兼容性，绝不执行 DDL。
生产必须显式配置 `PUBLIC_CREATE_MODE`、`ANONYMOUS_COMMENTS`、`RATE_LIMIT_MODE`
和至少 32 字节的 `IDEMPOTENCY_SECRET`。为每套环境创建配置中声明且互不复用的
D1/R2/DO/Analytics/限流资源，并把 `IDEMPOTENCY_SECRET` 与 `REPAIR_TOKEN`
保存为 Worker Secret，禁止写入已提交的 vars。使用 token 创建模式时设置
`PUBLIC_CREATE_MODE=token`，然后：

```sh
npx wrangler secret put CREATE_TOKEN --config wrangler.production.jsonc
# 然后客户端设置 OPEN_ARTIFACTS_TOKEN
```

直接执行 `pnpm run deploy` 会被刻意拒绝。必须通过受保护的 `Gated deployment`
工作流晋级完整 Commit SHA；工作流会重复验证、构建指定环境、先应用 Migration，
再部署 Worker。Release Manifest、Staging 演练、Canary 阈值和回滚规则统一收录在
[`docs/releases/`](docs/releases/README.md)。

本地开发：`pnpm dev`（状态持久化在 `.wrangler/state`）。

## 工作原理

| 关注点 | 设计 |
| --- | --- |
| 身份 | Artifact id 是 12 位加密随机串。创建时返回一次性的 `writeToken`，服务端只存 SHA-256。可注入 `Authorizer` 增加团队/账号策略；凭据支持轮换、宽限、撤销、状态查询与管理员恢复。 |
| 确定性来源 | 每个 Artifact 都由严格 Recipe 和有序片段生成。构建器注入 tokens；Canvas 还会注入 vendored runtime 与控制器。Manifest v2 记录 Recipe/input/output 哈希，CLI 拒绝直接发布 HTML/Markdown。 |
| 频道 | `artifact.channel` 把 artifact 绑定到稳定 URL。CLI 把每个频道的 token（`ch_`）保存在 `.artifacts/credentials.json`；之后用它在 `create` 上更新绑定的 artifact（新版本、同一链接），而不是新建一个。服务端只存频道哈希。 |
| 本地模式 | `artifact.local: true` 把私有来源放在 gitignore 的 `.artifacts/recipes.local/` 与 `.artifacts/fragments.local/`，状态放在 `manifest.local.json`。共享 Recipe/片段放在 `.artifacts/recipes/` 与 `.artifacts/fragments/`，可以提交；加密 Recipe 必须保持私有。 |
| 存储 | D1 保存元数据与 publication 状态，R2 保存不可变内容寻址对象。`pending → blob_ready → committed` 状态机只暴露完整内容，修复器处理 orphan/missing 边界。 |
| 版本 | 每次发布都不可变；`?v=N` 和 Viewer 内联版本选择器浏览历史，`PUT` 使用版本 CAS。Live 只保存带 revision 的 Draft，显式 Checkpoint 才生成下一版本，绝不原地修改历史。 |
| 服务 | Worker 把存储内容包进一个骨架（CSS reset、emoji favicon、viewport、带 `data-theme` 切换的浅色/深色主题），并以 `Content-Security-Policy: sandbox allow-scripts ...; default-src 'none'` 提供——artifact 脚本跑在不透明源里，无法发起任何外部请求。 |
| 链接预览 | 每个页面都输出 OpenGraph + Twitter 标签（标题、描述、图片）。`GET /og/:id` 用 `@resvg/resvg-wasm` 在边缘从内嵌的 Inter 子集栅格化出一张 1200x630 的 PNG 卡片——爬虫真正能渲染的位图（它们不认 SVG），自包含、无任何外部请求。 |
| 密码 | CLI 在本地加密：PBKDF2-HMAC-SHA256（60 万次迭代）+ AES-256-GCM。服务端只存 `{salt, iv, ciphertext}`。查看器提供一个解锁外壳，在浏览器里解密并渲染进一个沙箱 iframe。密码永不离开客户端。 |
| 自动更新 | Recipe 记录 `scope`、`watch` 和 `autoUpdate`，Manifest v2 保存发布快照。`artifact.mjs status` 报告过期 Artifact；可选 Stop hook 只展示主动开启自动更新的条目。Agent 更新 Recipe 片段，或对已审查的漂移执行 `ack`。 |
| Markdown | 客户端渲染（vendored 的 `marked`，内联——无 CDN），这样加密的 Markdown 也能在服务端永远看不到明文的情况下工作。 |

## API

```
POST   /api/artifacts           { content, favicon, title?, description?, format?, label?, encrypted?, channel? }
                                → 201 { id, url, writeToken, version, channel? }
PUT    /api/artifacts/:id       同上字段 + baseVersion?/force?   （Bearer writeToken 或 channel token）
GET    /api/artifacts/:id       元数据 + 版本历史
GET    /api/artifacts/:id/raw   存储内容（?v=N）
DELETE /api/artifacts/:id       （Bearer writeToken）
PUT    /api/artifacts/:id/live/draft       revision-CAS Draft 保存
POST   /api/artifacts/:id/live/checkpoint  不可变 Checkpoint 发布
GET    /a/:id                   渲染页面（?v=N）
```

客户端应发送 `Open-Artifacts-Protocol: 1`；不支持的显式版本返回 `426`。
版本化 Schema 与 Golden Fixtures 位于 `protocol/v1/`。

`encrypted` 是 `{ salt, iv, iterations }`（均为 base64/int），base64 密文作为 `content`。
`channel` 是频道 token（`ch_...`），指向已绑定该频道的 artifact，首次使用时则绑定新 artifact。
最大内容体积 4 MiB。

## 安全模型

- 在你自己的源上提供不受信任的 HTML 是经典的存储型 XSS 陷阱；这里每个用户内容响应都带
  CSP `sandbox` 指令（不透明源——无 cookie、无存储、无同源 API 调用），外加
  `default-src 'none'`、`connect-src 'none'`、`X-Content-Type-Options: nosniff`
  和 `Referrer-Policy: no-referrer`。
- `*.workers.dev` 在公共后缀列表上，把你的实例与其他站点隔离。
- 任何拿到未受保护 artifact URL 的人都能读它（类似 unlisted gist）。敏感内容用 `--password`；
  title/favicon 元数据仍是明文。
- 开发环境可以选择开放创建；生产禁止开放创建，并在 Binding、Secret、策略或 Migration 缺失时 fail closed。

## 开发

```sh
pnpm test          # Worker 集成测试（vitest + workerd）
pnpm test:cli      # 技能 CLI 测试
pnpm test:security # 授权、滥用、密码与配额边界
pnpm test:accessibility # 两主题、360px、键盘与 WCAG 2.2 AA
pnpm test:load     # 有界负载模型与浏览器 smoke
pnpm typecheck
pnpm check         # biome lint + format
pnpm verify        # 完整静态、契约、运维、审计与浏览器门禁
```

当前架构与运维契约见 `docs/architecture.md`、`protocol/README.md`、
`docs/quality-budgets.md` 与 `docs/runbooks/`。

MIT 协议。
