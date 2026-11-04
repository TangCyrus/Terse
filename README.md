# Terse

Terse 为 coding agent 提供任务相关的代码检索、修改前基线和修改后重复检查，帮助 agent 优先复用和修改已有实现。

当前版本为本地 CLI 原型，支持 JavaScript、TypeScript、JSX、TSX，以及 `.mjs`、`.cjs`、`.mts`、`.cts`。设计背景见 [DESIGN.md](DESIGN.md)。

参与开发请阅读 [开发文档](DEVELOPMENT.md)，其中包含模块职责、接口、验证方式和分模块 PR 的开发顺序。

## 安装与验证

需要 Node.js 24 或更新版本，以及 PATH 中可用的 Git。在仓库目录运行：

```sh
npm ci
npm run build
npm test
npm run demo
```

`npm run demo` 会在本仓库的 `.terse/demo-<时间戳>/` 下创建两个独立的 Git 示例项目，并依次执行真实的 `begin`、`context`、`check` CLI。它不修改 `examples/orders` 模板，也不需要 Git 提交或用户名配置。运行完成后保留示例代码、完整检查报告与 `comparison.json`，便于检查结果。

示例需求是为订单 CSV 导出增加付款状态筛选。两种实现运行相同的验收测试，覆盖默认行为、权限、CSV 转义、输入不变和金额校验：

- 复制版本：业务源文件由 21 行增加到 35 行，功能测试通过，检测到 1 处新增重复，状态为 `needs-review`。
- 复用版本：在现有函数增加参数与筛选条件，业务源文件保持 21 行，功能测试通过，新增重复为 0，状态为 `pass`。

行数仅说明这个示例的变化。示例证明了检索和重复检查可以运行，不代表已测得不同模型上的自动复用提升率。Terse 不会自动重写或删除项目源码。

## 在自己的项目上运行

先在目标项目根目录创建可选的 `terse.config.json`。验证命令会由 `check` 执行，应填写该项目真实的测试或检查命令：

```json
{
  "exclude": ["generated"],
  "minTokens": 50,
  "minLines": 5,
  "duplicatePolicy": "review",
  "verification": [
    {
      "command": "node",
      "args": ["--test", "test/orders.test.mjs"],
      "timeoutMs": 30000
    }
  ]
}
```

在 Terse 仓库目录使用 PowerShell：

```powershell
$terseCli = (Resolve-Path .\dist\cli.js).Path
$targetProject = 'D:\your-project'
$taskStart = node $terseCli begin --cwd $targetProject --task '订单导出增加付款状态筛选' --json | ConvertFrom-Json
node $terseCli context --cwd $targetProject --run $taskStart.run --query '订单导出 exportOrders paid'
```

`begin` 返回 run ID 和 `decisionPath`。在修改项目代码之前，让 agent 阅读 `context` 返回的候选，并填写该文件，例如：

```json
{
  "strategy": "modify",
  "rationale": "付款筛选属于现有导出职责，应保留共同的权限检查和 CSV 编码。",
  "considered": [
    {
      "path": "src/orders.ts",
      "symbol": "exportOrders",
      "disposition": "modify",
      "reason": "现有函数已负责订单导出，新增条件不需要第二套处理流程。"
    }
  ],
  "remove": []
}
```

之后完成需求修改，再运行：

```powershell
node $terseCli check --cwd $targetProject --run $taskStart.run
node $terseCli check --cwd $targetProject --run $taskStart.run --json
```

`--cwd` 可以是目标 Git 项目的子目录，分析范围会定位到 Git 根目录。若已通过自己的方式安装本地包，也可以直接使用 `terse` 命令。无需全局安装即可按上述步骤使用。

## 三个命令的职责

`begin --task <需求>` 保存任务开始时的实际 JS/TS 源码、内容哈希、配置、重要项目清单的哈希与可用的 HEAD。它包含已跟踪和未跟踪文件，不要求工作区干净，也支持尚无提交的 Git 仓库。缓存保存在目标项目的 `.terse/runs/<id>/`，建议将 `.terse/` 加入目标项目的 `.gitignore`；工具自身始终排除这个缓存目录。

`context --run <id> --query <关键词>` 提取函数、类、方法及类型声明，按名称、路径和源码内容排序。结果包含源码位置、内容哈希、限长片段、相对路径导入关系及按名称匹配的测试。默认最多 5 个候选，可用 `--limit 1..20` 调整。中文关键词可匹配中文注释；源码没有相关中文时请补充英文业务词或符号名。空结果不代表没有可复用实现。搜索证据会保存在 `context.json`。

`check --run <id>` 比较当前代码与任务基线，使用 jscpd 的 token 检测核心寻找新增或扩大的重复片段，检查决策中的候选与删除目标，并执行基线配置中的验证命令。完整结果写入 `report.json`，包括扫描文件数、排除范围、错误、验证输出、发现位置与快照标识。`--json` 返回同样的机器可读结果。

`--skip-verification` 可显式跳过验证，但会产生 `needs-review`。配置中没有验证命令也不能得到 `pass`。检查期间源码或项目清单发生变化时，结果为 `incomplete`，需要重新检查。

## 决策、配置与退出码

`strategy` 可选 `reuse`、`modify`、`refactor`、`new`。前三种至少需要一个 `reuse` 或 `modify` 的已有候选；`new` 可以在确实没有候选时使用空列表。`considered` 中的 `disposition` 可选 `reuse`、`modify`、`reject`，每项均需具体理由。候选必须存在于基线中。

`remove` 可以填写 `{ "path": "src/legacy.ts" }` 或 `{ "path": "src/orders.ts", "symbol": "oldExport" }`。声明删除的对象仍存在时检查失败。这里检查的是指定位置的文件或 AST 符号，不会推断所有动态调用或外部消费者是否已迁移。

`exclude` 使用相对于 Git 根目录的文件或目录前缀，以 `/` 分隔，不支持 glob。默认排除依赖、构建输出、覆盖率目录、声明文件、压缩 JS 和 Terse 缓存。超过 1 MiB、非 UTF-8、二进制或符号链接源文件会报告覆盖缺口；不跟随符号链接。

`minTokens` 至少为 10，`minLines` 至少为 1。`duplicatePolicy` 默认 `review`，表示新重复需要评估；设为 `fail` 可以阻断符合检测规则的新重复。相似代码仍可能承担合理的独立职责，首版没有自动豁免或语义合并功能。

验证通过独立的 `command` 与 `args` 执行，不启用 shell，不解析 `&&` 或重定向。`node` 会使用运行 Terse 的 Node 可执行文件。在 Windows 上需要运行 npm 脚本时，可显式配置 Node 加 npm CLI 路径，或配置实际检查器的 JavaScript 入口；不要把整个命令行塞进 `command`。单条命令超时默认 30 秒，可配置为 100 毫秒至 300 秒。

配置在 `begin` 时固定；任务期间配置变化会使检查未完成。修改配置后，应评估变化并开始新 run。首版是本地辅助工具，不将这份本地状态视为防篡改的合并凭据。

- `0 / pass`：规定检查完成且无待处理项，结论只针对记录的快照和分析范围。
- `1 / fail`：验证失败、声明删除未完成，或触发配置为失败的新重复规则。
- `2 / needs-review`：有新增重复、决策或检索记录缺失、验证缺失或覆盖缺口。
- `3 / incomplete`：参数、解析、存储、检测器或验证启动错误，策略变化，超时，或检查期间代码变化。

## 给 agent 的工作约定

可以将以下步骤加入任务说明：

1. 修改代码前执行 `begin`，确定功能验收条件。
2. 执行 `context`，阅读候选源码、相关调用位置和测试；必要时换关键词继续查找。
3. 在 `decision.json` 中记录复用、修改或新增的理由，以及计划删除的实现。
4. 实施需求并处理被替代代码。
5. 执行 `check`，处理实际问题，并在源码变更后重新验证。
6. 交付时说明复用了什么、为何新增、清理了什么、哪些验证完成或仍有缺口。

工具返回过代码不代表 agent 已理解代码。该约定属于行为引导，首版没有接管编辑工具、强制宿主 hook 或 CI 合并门槛。

## 分析范围与后续方向

重复检测复用 [jscpd 的 Node API 组件](https://github.com/kucherenko/jscpd/blob/master/README-v4.md)，只安装检测核心和 tokenizer。它忽略空白与注释，保留标识符和字面量；首版不做变量改名归一化、跨语言语义检测或自动合并。不同 tokenizer 格式间的重复可能漏报。

重复基线通过片段 token 指纹及出现数量比较，避免将未变化或移动的旧重复计为新增。它不是完整的编辑历史追踪，片段边界改变可能需要人工评估。每次检查分析基线与当前快照，当前版本没有大型仓库持久化索引或性能承诺。

源码结构复用固定版本的 [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)。首版进行语法解析与词法检索，尚不提供完整类型检查、tsconfig 路径别名解析、精确符号调用图或业务职责判断；项目可以配置自身的类型检查与测试命令。

工作区被其他进程同时编辑时，只能报告任务期间的变化，不能证明每处改动来自哪个 agent。验证输出会截断到 12,000 字符；命令失败和输出超限不会被算作通过。缓存含项目源码，保留在本地，不自动上传。

后续优先扩展真实项目评测、符号引用与清理检查、例外处置和 CI 接入，再根据需求添加 MCP。当前原型不包含完整的补丁叠加或业务职责检测。
