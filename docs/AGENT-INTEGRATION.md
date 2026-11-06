# Agent Skill 与项目初始化

`init` 将 Terse 安装到项目。Agent 接到普通 JavaScript/TypeScript 功能、修复、删除或重构需求后，项目说明会引导它读取 Skill，完成检索、决策、实施和完整检查，用户无需每次附带 Terse 命令。

首版面向能读取 AGENTS.md 和项目级 Agent Skills、能够编辑文件并运行 Node.js/Git 的宿主。Codex 的 [Skill 发现规则](https://learn.chatgpt.com/docs/build-skills) 支持 `.agents/skills` 和按描述隐式选择；[项目指令规则](https://learn.chatgpt.com/docs/agent-configuration/agents-md) 说明 AGENTS.md 与 AGENTS.override.md 的优先级。其他宿主可复用 Skill，但须确认发现路径和指令加载能力。本版没有 MCP、宿主 hook 或编辑拦截，也不保证宿主遵守所有指令。

## 安装到项目

先在 Terse 仓库完成 `npm ci` 和 `npm run build`。目标须是 Git 工作区，支持尚未提交和没有初始提交的项目；初始化不修改源码、不安装依赖、不调用模型、不执行验证命令。

```powershell
$terseCli = (Resolve-Path .\dist\cli.js).Path
node $terseCli init --cwd 'D:\your-project' --json
```

已有合法 `terse.config.json` 时逐字保留。没有配置时创建默认策略和空 verification，返回 `needs-review` / 退出码 2、`VERIFICATION_NOT_CONFIGURED`。在 begin 前配置项目真实测试或类型检查；不会猜测 `npm test` 或生成无意义的通过命令。例如，一个使用 Node 测试运行器的项目可配置：

```json
{
  "verification": [
    {"command": "node", "args": ["--test", "test/orders.test.mjs"], "timeoutMs": 30000}
  ]
}
```

已确定命令时，可在新配置上使用 `--verify`。每个值是包含 command、args 和可选 timeoutMs 的 JSON 对象，可重复指定多个检查；按当前 shell 的规则传递 JSON 字符串：

```sh
node /path/to/Terse/dist/cli.js init --cwd /path/to/project --verify '{"command":"node","args":["--test","test/orders.test.mjs"]}' --json
```

`--verify` 不替换或追加已有配置，已有文件与该参数同时出现时拒绝操作，须显式编辑配置。命令沿用 check 的无 shell 执行方式；不要把整条 shell 命令填进 command。Windows 上应选择可直接执行的程序或 `node <实际测试入口>`，不要依赖 shell 解析 `.cmd`、管道或通配符。Node 24 测试运行器自身支持的 glob 可作为独立 args 项传递。

## 初始化文件与重复执行

- `.agents/skills/terse/SKILL.md`：开发任务的触发范围、调用顺序、决策与反馈处理。
- `.agents/skills/terse/agents/openai.yaml`：允许隐式选择，无需显式点名 Skill。
- `.agents/skills/terse/scripts/run.mjs`：使用当前 Node 启动本地 CLI，转发参数、输出和退出码。
- `AGENTS.md`：追加有边界标记的 Skill 引导，保留原有内容和换行。根目录有非空 AGENTS.override.md 时，追加到实际生效的 override，保留 AGENTS.md。
- `terse.config.json`：保留已有配置，或创建默认配置。
- `.gitignore`：缓存尚未被 Git 忽略时追加 `/.terse/`，保留现有规则。
- `.terse/agent.json`：当前工作区的本地 CLI 绑定，受忽略，不提交本机路径。

初始化先检查全部目标，再写文件。遇到自定义同名 Skill、修改过的 Terse 指令块、无效配置、符号链接或错误的文件/目录类型会拒绝操作。处理冲突时保留自己的文件并显式整理，不提供 force 覆盖。普通重复执行不会重复追加指令或改写相同内容；CLI 移动后再次 init 可更新缓存绑定。写入时的文件系统错误可能留下已完成的文件，修复后可重试；它不是文件系统事务。

可提交 Skill、项目指令和配置，让团队共享约定。每位使用者须在自己的 checkout 运行本地 Terse 的 init 建立绑定；不提交缓存或要求全局安装。Node/Git 和项目测试依赖需在 agent 的实际执行环境中可用。

## 正常需求的执行过程

安装后开启新的 agent 会话以加载项目指令。更深层的指令覆盖、宿主上下文长度限制或禁用隐式 Skill 都可能影响加载；已有会话可显式要求读取项目 Skill。

用户正常提出“订单导出支持付款状态筛选，保留原有行为”即可。Agent 按 Skill：

1. 修改前运行 begin --query，保存 run，阅读既有候选、消费者和测试；需要更多证据才继续 context。
2. 使用返回的 candidateId 和 decisionGuide 保存实际的 reuse / modify / refactor / new 决策及删除声明。
3. 用自己的编辑工具实现需求，保持行为并清理旧路径。
4. 经项目启动器执行 verificationGuide 的完整 check；summary 保留全部检查和验证，不默认在其前后重复整套测试。
5. 对 fail 修正后重检，对 needs-review 审查职责和不确定引用，对 incomplete 修复执行或分析问题。保持原任务基线，不通过重新 begin、放松策略或跳过测试获取通过。

在 Git 根目录的启动命令为：

```sh
node .agents/skills/terse/scripts/run.mjs begin --task '<用户需求>' --query '<业务词与符号>' --json
```

启动器以项目根目录为工作目录，使用绝对启动器路径时也可从其他目录调用；返回的 guide 参数包含规范化项目路径。它不会替 agent 选择候选、生成理由或编辑代码。绑定缺失/失效或 Node 启动失败时退出码为 3，stderr 给出恢复指引，可能没有 JSON，宿主不能解释成通过。

## 示例与验证边界

```sh
npm run demo:agent
```

示例复用订单项目、原行为验收和新增付款筛选验收，调用实际 init 与项目启动器。先构造行为通过但复制实现的草稿，完整 check 返回 needs-review 和新增重复；随后修改原函数，用同一 run 和完整验证得到 pass。两次完整报告及 integration.json 保存在 `.terse/agent-demo-<id>/`。

这是确定性接入回归，标记 scripted-integration / modelSessions: 0，不声称证明自然语言自动选择率、模型自主纠错成功率或新增对照收益。[初始化测试](../test/init.test.mjs) 另覆盖已有配置与指令保留、重复安装、根 override、未知验证、命令校验、路径冲突、目录链接拒绝、工作目录和退出码传递。另设 [Skill 真实会话评测](SKILL-AGENT-BENCHMARK.md)，在普通任务提示下独立测量实际接入阶段；与 demo 分开解释，历史评测、输入归档和哈希不改写。

真实开源项目的扩展使用 [p-queue Skill 接入评测](PQUEUE-SKILL-BENCHMARK.md)，保留原有构建、任务验收、上游和类型验证。它与订单示例分开发布，不把历史显式提示会话当成普通需求下的自动接入。
