# 项目技术报告

更新时间：2026-05-28
项目路径：`C:\Users\Administrator\Documents\Codex\2026-05-26\vibe-coding-swe-agent`

## 1. 一句话结论

这个项目已经不是“只有聊天框外壳”的半成品了，它现在是一个能跑起来的最小版 SWE Agent：

- 前台有聊天界面
- 后台有 `/api/agent` 接口
- 代理主循环已经接上真实模型调用
- 代理已经能决定是否调用工具
- 已经有文件读写草稿、安全命令、网页读取、Git/GitHub 检查这些能力

但它还不是一个完整产品，主要还缺：

- 真正的测试体系
- 数据持久化
- 多用户/登录
- 更成熟的命令与文件安全策略
- 更完整的文档同步

## 2. 当前文件结构

### 2.1 核心目录树

```text
vibe-coding-swe-agent/
├─ src/
│  ├─ app/
│  │  ├─ api/agent/route.ts
│  │  ├─ globals.css
│  │  ├─ layout.tsx
│  │  └─ page.tsx
│  ├─ components/chat/chat-shell.tsx
│  ├─ lib/
│  │  ├─ agent/run-agent.ts
│  │  └─ tools/
│  │     ├─ click-page.ts
│  │     ├─ git-inspect.ts
│  │     ├─ list-files.ts
│  │     ├─ pending-write.ts
│  │     ├─ read-file.ts
│  │     ├─ read-page.ts
│  │     ├─ replace-text.ts
│  │     ├─ safe-command.ts
│  │     ├─ search-text.ts
│  │     ├─ tool-registry.ts
│  │     ├─ types.ts
│  │     ├─ web-search.ts
│  │     ├─ workspace-path.ts
│  │     └─ write-file.ts
│  └─ types/agent.ts
├─ data/
│  └─ workspace/
│     ├─ docs/plan.txt
│     ├─ data/workspace/streaming-check.txt
│     ├─ hello.txt
│     ├─ project-note.txt
│     ├─ test-note.txt
│     ├─ yes-no-button-test.txt
│     ├─ yes-no-selftest.txt
│     ├─ confirm-word-test.txt
│     ├─ lifecycle-check-en.txt
│     ├─ lifecycle-check-en-2.txt
│     ├─ 中文生命周期测试.txt
│     ├─ 罗祖卡.txt
│     └─ 罗祖卡.py
├─ public/
├─ scripts/
├─ test-results/
│  └─ .last-run.json
├─ .env.local
├─ .gitignore
├─ HANDOFF.md
├─ next-env.d.ts
├─ next.config.ts
├─ package-lock.json
├─ package.json
├─ PROJECT_TECH_REPORT.md
├─ README.md
└─ tsconfig.json
```

### 2.2 非核心但当前存在的目录

- `.git/`：Git 仓库元数据
- `.next/`：生产构建产物
- `.next-dev/`：开发模式构建产物
- `node_modules/`：依赖包

### 2.3 根目录里的日志文件

这些文件都属于“本地调试痕迹”，不是业务代码：

- `.codex-dev.log`
- `.codex-dev-2.log`
- `.codex-dev-fresh.log`
- `.codex-stream-dev.err.log`
- `.codex-stream-dev.out.log`
- `.codex-replace-test.err.log`
- `.codex-replace-test.out.log`
- `.codex-replace-test-3001.err.log`
- `.codex-replace-test-3001.out.log`
- `.deepseek-dev.err.log`
- `.deepseek-dev.log`
- `.multi-step-test-3016.err.log`
- `.multi-step-test-3016.out.log`
- `.open-preview.err.log`
- `.open-preview.log`
- `.safe-command-start.err.log`
- `.safe-command-start.log`
- `.safe-command-start-3102.log`
- `.tool-dev.err.log`
- `.tool-dev.log`
- `.web-search-test.log`
- `.web-search-test-3012.log`
- `.web-search-test-3013.log`
- `.web-search-test-3014.log`
- `.web-search-test-3015.log`

## 3. 每个文件的职责

### 3.1 根目录配置与文档

| 文件 | 职责 |
| --- | --- |
| `.env.local` | 本地环境变量。现在主要放 DeepSeek 兼容接口需要的模型配置和密钥。 |
| `.gitignore` | 告诉 Git 哪些文件不要提交，比如依赖、构建产物、日志、环境变量。 |
| `HANDOFF.md` | 交接文档，记录之前阶段做了什么、建议下一步做什么。内容已经部分过时。 |
| `next-env.d.ts` | Next.js 自动生成的 TypeScript 类型声明入口。 |
| `next.config.ts` | Next.js 配置文件。这里主要做了开发产物目录和生产产物目录分离。 |
| `package-lock.json` | 锁定依赖版本，保证别人安装时和你装到的版本尽量一致。 |
| `package.json` | 项目说明书。定义项目名、依赖、脚本命令。 |
| `README.md` | 项目总说明，介绍工作区、安全边界和基础目录。内容比当前代码状态旧。 |
| `tsconfig.json` | TypeScript 配置，规定路径别名、类型检查规则等。 |

### 3.2 前端页面文件

| 文件 | 职责 |
| --- | --- |
| `src/app/layout.tsx` | 整个网页最外层布局壳子，设置页面标题和描述。 |
| `src/app/page.tsx` | 首页入口，只负责把聊天主组件挂上去。 |
| `src/app/globals.css` | 全局样式表，定义页面配色、排版、聊天面板、步骤面板、按钮等样式。 |
| `src/components/chat/chat-shell.tsx` | 聊天界面的核心。负责输入框、消息列表、步骤展示、发送请求、读取流式返回、处理 YES/NO 草稿确认。 |

### 3.3 后端接口文件

| 文件 | 职责 |
| --- | --- |
| `src/app/api/agent/route.ts` | 后端接口入口。接收前端任务，校验输入，调用代理主循环，支持普通 JSON 返回和流式 SSE 返回。 |

### 3.4 代理核心文件

| 文件 | 职责 |
| --- | --- |
| `src/lib/agent/run-agent.ts` | 项目最核心的“大脑”。负责 Perceive -> Think -> Act 主循环、模型调用、工具选择、草稿审批流、上下文维护、工具结果整合。 |
| `src/types/agent.ts` | 前后端共用的数据格式定义，比如聊天消息、步骤、请求体、返回体、会话上下文。 |

### 3.5 工具系统文件

| 文件 | 职责 |
| --- | --- |
| `src/lib/tools/types.ts` | 定义工具通用类型，相当于所有工具共同遵守的“插头标准”。 |
| `src/lib/tools/tool-registry.ts` | 工具注册表。把所有工具集中挂起来，供代理按名字调用。 |
| `src/lib/tools/workspace-path.ts` | 工作区路径保护。确保文件操作只能发生在允许的目录里。 |
| `src/lib/tools/list-files.ts` | 列出工作区内某个目录下的文件和文件夹。 |
| `src/lib/tools/read-file.ts` | 读取工作区内一个 UTF-8 文本文件。 |
| `src/lib/tools/search-text.ts` | 用 `rg` 在工作区里做全文搜索。 |
| `src/lib/tools/write-file.ts` | 生成“写文件草稿”，不会直接落盘。 |
| `src/lib/tools/replace-text.ts` | 生成“替换文本草稿”，要求旧文本只能精确匹配 1 次。 |
| `src/lib/tools/pending-write.ts` | 暂存待批准草稿，并在批准后真正写入磁盘。 |
| `src/lib/tools/safe-command.ts` | 执行白名单命令，只允许非常有限的 `git`、`npm`、`rg`。 |
| `src/lib/tools/web-search.ts` | 走 Bing RSS 做公网搜索，返回标题和链接。 |
| `src/lib/tools/read-page.ts` | 用 Playwright 打开网页并提取标题、最终地址、正文样例。 |
| `src/lib/tools/click-page.ts` | 用 Playwright 打开网页并点击一个元素，再抓取点击后的页面结果。 |
| `src/lib/tools/git-inspect.ts` | Git/GitHub 检查工具，能看仓库状态、diff、summary、GitHub 连接状态、issue 列表、issue 详情、issue 执行计划、commit/PR 草稿建议。 |

### 3.6 默认演示工作区文件

这些文件更像“沙盘里的道具”，用来让 agent 练习读文件、搜文本、改文本。

| 文件 | 职责 |
| --- | --- |
| `data/workspace/hello.txt` | 简单文本样例，用来验证最基本读写。 |
| `data/workspace/project-note.txt` | 演示说明文件，提示本地工具会从这个目录读文件。 |
| `data/workspace/test-note.txt` | 最小测试文本。 |
| `data/workspace/yes-no-button-test.txt` | YES/NO 相关交互测试样例。 |
| `data/workspace/yes-no-selftest.txt` | YES/NO 自测样例。 |
| `data/workspace/confirm-word-test.txt` | 确认词测试样例。 |
| `data/workspace/lifecycle-check-en.txt` | 英文版生命周期测试样例。 |
| `data/workspace/lifecycle-check-en-2.txt` | 第二份英文生命周期测试样例。 |
| `data/workspace/中文生命周期测试.txt` | 中文版生命周期测试样例。 |
| `data/workspace/罗祖卡.txt` | 中文文本样例文件。 |
| `data/workspace/罗祖卡.py` | Python 文本样例文件，用来测试代码文件读取或修改。 |
| `data/workspace/docs/plan.txt` | 演示型计划文件，提示 agent 先列目录再读文件。 |
| `data/workspace/data/workspace/streaming-check.txt` | 流式返回检查样例。 |

### 3.7 其他目录与文件

| 文件或目录 | 职责 |
| --- | --- |
| `public/` | 静态资源目录，目前为空。 |
| `scripts/` | 脚本目录，目前为空。 |
| `test-results/.last-run.json` | 某次测试运行的状态记录，目前显示失败状态，但仓库里没有对应测试代码。 |
| 根目录各类 `*.log` | 本地调试输出，不属于产品逻辑。 |

## 4. 已实现的功能列表

### 4.1 用户界面层

1. 已有可用聊天页面。
2. 已有任务输入框和发送按钮。
3. 已有消息气泡展示用户和助手对话。
4. 已有右侧步骤面板，能显示 `Perceive -> Think -> Act` 过程。
5. 已有草稿审批 UI，出现待写入草稿时会显示 YES / NO 按钮。

### 4.2 接口与通信层

1. 已实现 `POST /api/agent`。
2. 已支持普通请求返回 JSON。
3. 已支持流式返回 SSE，也就是后端可以边跑边把步骤推给前端。
4. 已有请求体校验，空任务和非法 JSON 会直接报错。

### 4.3 Agent 主循环

1. 已实现真实的 `runAgent()` 主循环。
2. 已实现 `Perceive -> Think -> Act` 三阶段状态输出。
3. 已支持最多 4 次工具调用的预算控制。
4. 已支持最近对话上下文传递。
5. 已支持会话上下文记录：
   - 上次列过的目录
   - 上次读过的文件
   - 上次调用的工具
   - 当前待批准草稿
6. 已支持直接回答，也支持“先用工具再回答”。

### 4.4 模型接入

1. 已接入真实模型调用，不再是纯 mock。
2. 使用的是 `openai` SDK，但实际通过 `baseURL` 对接 DeepSeek 兼容接口。
3. 当前默认模型来自环境变量 `DEEPSEEK_MODEL`，默认值是 `deepseek-v4-flash`。

### 4.5 文件工具能力

1. 已能列出目录。
2. 已能读取文本文件。
3. 已能全文搜索文本。
4. 已能生成整文件写入草稿。
5. 已能生成精确替换草稿。
6. 已能在用户批准后把草稿真正写到磁盘。
7. 已有工作区路径防越界保护，防止工具跑到允许目录外面。

### 4.6 安全闸门

1. 写文件不是直接写，而是先出草稿。
2. 只有明确批准后才会真正写入。
3. 模糊确认词会被拦下来，要求更明确的批准/取消指令。
4. `safe_command` 只允许非常有限的命令：
   - `git status`
   - `npm run build`
   - `npm test`（前提是项目里真的有 test 脚本）
   - `rg` 搜索
5. 明确屏蔽了 `bash`、`powershell`、`python`、`curl`、`rm` 等高风险命令。

### 4.7 网页与浏览工具

1. 已支持网页搜索。
2. 已支持打开网页并读取正文样例。
3. 已支持打开网页并点击一个简单元素。
4. 已支持把网页读取结果整理成适合直接回答用户的格式。

### 4.8 Git / GitHub 工具

1. 已能判断当前工作区是不是 Git 仓库。
2. 已能读取 `git status`。
3. 已能读取最小 diff 预览。
4. 已能输出本地改动摘要。
5. 已能检查 GitHub remote、`gh` CLI、登录状态。
6. 已能生成 commit message 建议。
7. 已能生成 PR 草稿建议。
8. 已能读取仓库信息。
9. 已能读取 issue 列表和单个 issue 详情。
10. 已能把 issue 文本转成一个最小执行计划。

### 4.9 构建验证

2026-05-28 我实际执行了 `npm run build`，结果成功，说明：

- 项目当前可以通过生产构建
- TypeScript 类型检查通过
- Next.js 页面可正常打包

## 5. 使用的技术栈

### 5.1 前端

- Next.js 15
- React 19
- App Router
- 原生 CSS

### 5.2 后端

- Next.js Route Handler
- Node.js 运行时

### 5.3 AI 与 Agent

- `openai` Node SDK
- DeepSeek 兼容接口
- 自定义 Agent 循环
- 自定义工具注册与调用系统

### 5.4 自动化与网页操作

- Playwright

### 5.5 工程工具

- TypeScript
- ESLint
- ripgrep (`rg`)
- Git
- GitHub CLI（在 GitHub 检查逻辑中被支持）

## 6. 还未实现的功能

下面这些是“明显还没有”或者“只做了一半”的部分。

### 6.1 产品层缺失

1. 没有用户系统。
2. 没有登录、权限、多人协作。
3. 没有任务历史持久化。
4. 没有数据库。
5. 没有真正的项目设置页面。

### 6.2 Agent 能力缺失

1. 没有长期记忆。
2. 没有多代理协作。
3. 没有真正复杂的规划拆解界面。
4. 没有工具权限分级系统。
5. 没有更细粒度的文件 diff 审批界面。
6. 没有真正的终端会话管理，只是有限白名单命令。

### 6.3 测试与质量缺失

1. 没有看到正式的单元测试文件。
2. 没有看到正式的集成测试文件。
3. `package.json` 里没有 `test` 脚本。
4. `test-results/.last-run.json` 存在，但仓库里没有对应完整测试体系。

### 6.4 工程化缺失

1. `public/` 目录还是空的。
2. `scripts/` 目录还是空的。
3. 没有 Docker 配置。
4. 没有 CI 配置。
5. 没有部署配置文件。
6. 没有单独的错误监控或日志上报系统。

### 6.5 文档同步缺失

1. `README.md` 里还写着 `src/lib/search`，但当前仓库没有这个目录。
2. `HANDOFF.md` 还在说 `mock-agent.ts` 是当前核心，但现在项目已经换成了真实的 `run-agent.ts`。
3. 文档里的“已完成状态”落后于实际代码能力。

## 7. 当前项目状态判断

如果用大白话说，这个项目现在属于：

“能演示核心思路、也能跑通关键链路，但还没到稳定产品阶段。”

更具体一点：

- 它已经能展示一个最小版 AI 编码助手是怎么工作的
- 它已经有真实模型、真实工具、真实安全闸门
- 它适合继续做教学、演示、迭代
- 但还不适合直接当成熟产品交付

## 8. 下一步最值得做的 5 件事

1. 补测试
   先给 `run-agent.ts`、`write-file.ts`、`replace-text.ts`、`safe-command.ts` 加最小测试。

2. 整理文档
   先把 `README.md` 和 `HANDOFF.md` 更新到和代码一致。

3. 把草稿系统做成更清楚的 diff 审批
   现在能审批，但展示还不够直观。

4. 给工具调用加更稳定的错误分类
   现在很多报错还是“文本提示”，还不够结构化。

5. 做持久化
   现在待批准草稿和上下文主要在内存里，服务重启后容易丢。

## 9. 结论

这是一个已经跨过“界面 demo”阶段的最小可运行 Agent 项目。

它当前最有价值的地方不是页面有多漂亮，而是它已经把下面这条链路串起来了：

`用户输入 -> 后端代理 -> 模型判断 -> 工具调用 -> 安全审批 -> 返回结果`

这条链路已经成立。接下来主要不是“从 0 到 1”，而是“把 1 做稳、做清楚、做完整”。
