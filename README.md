# Terse

Terse 为 coding agent 提供任务相关的代码检索、修改前基线和修改后重复检查，帮助 agent 优先复用和修改已有实现。

代码精简任务现在有可执行入口：`simplify` 可将同文件、签名和函数体一致的普通函数收敛到一个实现，保留原公开入口；`--apply` 实际写入并执行全部项目验证，成功后给出真实代码减少量。`npm run demo:simplify` 验证“先移除已有重复体，再在原实现增加需求”的过程。范围、结果与限制见 [执行代码精简](docs/SIMPLIFICATION.md)。

当前版本为本地 CLI 原型，支持 JavaScript、TypeScript、JSX、TSX，以及 `.mjs`、`.cjs`、`.mts`、`.cts`。设计背景见 [DESIGN.md](DESIGN.md)。

参与开发请阅读 [开发文档](DEVELOPMENT.md)，其中包含 M1–M6 的合并进度、当前接口、验证方式和后续分模块交付计划。

删除或迁移基线文件、已索引声明时，check 会核对 `decision.remove`，漏填返回 fail 和可补全的 `undeclaredRemovals`；原地修改仍允许空列表。文件保留时的私有方法提取须填写精确符号，补全后继续处理残留引用与复核项。详见 [删除声明约束](docs/REMOVAL-DECLARATIONS.md)。

已有项目可运行 `node <Terse>/dist/cli.js init --cwd <项目>`，安装项目级 Agent Skill 与指令。随后在该项目开启 agent 会话，普通 JS/TS 开发需求即可按项目约定触发检索、决策和完整检查。已有配置保留，缺少真实验证命令时会提示补齐。安装与能力边界见 [Agent 接入](docs/AGENT-INTEGRATION.md)，`npm run demo:agent` 可验证完整接入及重复提示后的修正流程。

`npm run benchmark:skill` 用独立新会话验证安装后的实际接入：任务只给普通开发需求，分别测量修改前读取/检索/决策、最终完整检查和独立行为验收。本轮修改、删除、重构各两次，六个真实会话均自主完成流程，行为、复用与清理审查达标。方法与局限见 [Skill 真实会话评测](docs/SKILL-AGENT-BENCHMARK.md)；这是当前宿主的小样本接入证据，不与确定性 demo 或旧对照数据混算，也不推断相对收益。

真实开源项目入口为 `npm run benchmark:skill -- --suite p-queue --source <固定工作区>`，沿用 p-queue 的修改、删除和重构验收，保留编译、任务行为、上游 AVA 和严格类型四组检查。六次真实会话的行为、复用与清理审查均达标，但两次重构漏填删除声明，严格工作流仅 4/6 通过。结果与限制见 [p-queue Skill 接入评测](docs/PQUEUE-SKILL-BENCHMARK.md)，数据与历史分开保存。

合并删除声明约束后的新一轮 p-queue 复测中，行为与复用/实际清理审查 6/6 达标，四次有删除目标的会话均主动声明。没有自然遗漏，尚无真实补填修正证据；两次重构保留 M4 复核，严格工作流仍为 4/6。方法及指标区别见 [p-queue 删除声明复测](docs/PQUEUE-REMOVAL-SKILL-BENCHMARK.md)，历史数据不回填。

## 安装与验证

需要 Node.js 24 或更新版本，以及 PATH 中可用的 Git。在仓库目录运行：

```sh
npm ci
npm run build
npm test
npm run demo
```

`npm run demo` 会在本仓库的 `.terse/demo-<时间戳>/` 下创建两个独立的 Git 示例项目，并执行真实的 `begin --query`、`decide`、`check --summary` CLI。它不修改 `examples/orders` 模板，也不需要 Git 提交或用户名配置。运行完成后保留示例代码、完整检查报告与 `comparison.json`，便于检查结果。

示例需求是为订单 CSV 导出增加付款状态筛选。两种实现运行相同的验收测试，覆盖默认行为、权限、CSV 转义、输入不变和金额校验：

- 复制版本：业务源文件由 21 行增加到 35 行，功能测试通过，检测到 1 处新增重复，状态为 `needs-review`。
- 复用版本：在现有函数增加参数与筛选条件，业务源文件保持 21 行，功能测试通过，新增重复为 0，状态为 `pass`。

行数仅说明这个示例的变化。示例证明了检索和重复检查可以运行，不代表已测得不同模型上的自动复用提升率。普通 check 不改写源码；显式 simplify --apply 执行上述限定范围的源代码精简。

`npm run evaluate` 包含多文件订单项目的 6 个场景、11 个实现变体，覆盖修改、删除、重构、合理新增，以及独立职责与动态引用反例。新增改写式重复反例明确展示：行为通过且新增 token 重复为零，仍可能存在另一套同职责实现。方法、结果和限制见 [项目评测](docs/EVALUATION.md)。这是人工编写变体的受控评测。

`npm run benchmark:reuse` 在同一组六类任务上运行真实 agent 对照，以行为、实际复用、清理和职责边界为主要标准；补丁逐份审查，耗时仅作辅助。运行方式和判定规则见 [功能效果评测](docs/FUNCTIONAL-AGENT-BENCHMARK.md)。模型会话不进入 CI。

首轮 12 次真实会话中，两组各 6/6 行为与补丁审查达标，尚未观察到 Terse 相对对照组的改善。该历史版本未检出改写式重复反例；合并 M3 实现复核后，当前回归预期已改为 needs-review，原观测和哈希保持不变。当前仍不能保证没有同职责重复；详见上述评测的能力边界。

合并 M3 / M5 后另完成 12 次真实复测，数据单独保存在 [optimized-observed](benchmarks/reuse/optimized-observed/comparison.json)。两组各 6/6 行为与功能审查达标，新增精确重复和独立相似实现均为 0；删除、重构及动态迁移均完成清理，合理新增和独立权限保留。仍未观察到相对对照组的功能改善；Terse 总会话耗时约多 31.5%，仅作辅助记录。历史数据及哈希未变。

[发现与修正对照](docs/CORRECTION-AGENT-BENCHMARK.md) 另完成四类任务、八次真实会话：两类预置接手问题均记录到 Terse 提示后修正、完整复验及父分析确认的轨迹；两类自然任务两组都直接避免问题，无修正机会。两组最终各 4/4 达标，仍未观察到相对 control 的最终收益。预置问题不冒充 agent 自发重复，旧数据不回填或覆盖。

[复杂自然开发对照](docs/NATURAL-AGENT-BENCHMARK.md) 从正常的 12 模块项目运行三个任务、每类两对，共 12 个首稿/复核运行（24 次模型调用）。两组各六份首稿已通过固定验收并复用、清理到位，未观察到 Terse 减少自然重复或遗漏。首稿和终稿分别留证；未覆盖的兼容边界另作不计分观察，不能把固定 pass 当成完整正确性证明。四轮历史数据均单独保留。

实际 agent 对照入口为 `npm run benchmark:agent -- --source <p-map 工作区>`，使用固定开源版本、独立会话和事后验收，比较有无 Terse 的正确性、重复和墙钟时间。它需要单独登录的 Codex CLI，不在常规 CI 中调用模型。准备方式、真实观测与限制见 [开源项目 agent 评测](docs/AGENT-BENCHMARK.md)。

多文件 TypeScript 评测使用 `npm run benchmark:agent -- --suite p-queue --source <p-queue 工作区>`，覆盖修改、删除和重构三类任务，以优化后的命令式接入做 12 次独立会话对照。任务、验收、配置准备边界与结果见 [p-queue agent 评测](docs/COMPLEX-AGENT-BENCHMARK.md)。

M4/M5 优化后的 [真实 agent 复测](docs/COMPLEX-AGENT-BENCHMARK.md#优化后真实-agent-复测) 使用同一固定任务，单独保留新旧数据及决策重试证据。两组本轮各 6/6 正确、token 新重复均为 0；Terse 记录重试由历史 1 次变为 0 次，但总体耗时基本持平，未观察到进一步减少重复或整体提速。

## 自动化检查

[CI 工作流](.github/workflows/ci.yml) 在面向 `main` 的 PR 和 `main` 推送时运行，使用 Node.js 24 分别在 Linux、Windows 执行 `npm ci` 与 `npm test`，再通过 `npm pack --dry-run` 预检打包并显示文件清单。`npm test` 已包含 TypeScript 构建、导入解析、清理检查、CLI 输出契约、订单导出对比示例和项目评测，不额外重复运行示例。评测摘要写入测试诊断日志，完整项目与报告在运行目录保留。打包预检不发布或上传 npm 包。

PR 的 Checks 页面会显示 `Node 24 / ubuntu-latest` 和 `Node 24 / windows-latest` 两项检查。一项失败不会取消另一项，便于比较平台差异；同一 PR 的新提交会取消旧运行。安装、构建、测试或打包预检失败会让对应检查失败。

工作流合并到默认分支后，也可以从 GitHub Actions 页面手动运行。仓库是否强制要求检查通过才能合并，由分支保护或规则集决定；新增工作流本身不会修改这些设置。

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
$taskStart = node $terseCli begin --cwd $targetProject --task '订单导出增加付款状态筛选' --query '订单导出 exportOrders paid' --json | ConvertFrom-Json
$taskStart.context.candidates
```

`begin --query` 在同一调用中保存基线并执行检索，返回 run ID、`decisionPath`、嵌套 `context` 和 `decisionGuide`。先阅读候选源码与调用关系，再明确选定候选并记录决策，例如：

```powershell
$candidate = $taskStart.context.candidates | Where-Object { $_.path -eq 'src/orders.ts' -and $_.symbol -eq 'exportOrders' }
node $terseCli decide --cwd $targetProject --run $taskStart.run --strategy modify --candidate $candidate.candidateId --rationale '付款筛选属于现有导出职责，应复用权限检查和 CSV 编码。' --json
```

`decide` 负责写入下述格式，省去 agent 手写字段。需要分别解释多个候选或声明符号删除时，可准备同格式文件并使用 decisionGuide.inputArgvTemplate 调用 `decide --input <file>`；格式错误会返回 `DECISION_INVALID` 和具体 `issues[].field`，不会覆盖原记录。此命令替换完整决策，不做隐式追加或候选选择。仍支持直接编辑 `decision.json`：

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
node $terseCli check --cwd $targetProject --run $taskStart.run --summary --json
```

人工阅读可省略 `--summary --json`；选用一种输出形式即可，不需要为了显示两种格式重复执行验证。

`--cwd` 可以是目标 Git 项目的子目录，分析范围会定位到 Git 根目录。若已通过自己的方式安装本地包，也可以直接使用 `terse` 命令。无需全局安装即可按上述步骤使用。

## 命令的职责

Agent 的 JSON 接口使用输出契约 v1，公共字段包含 `schemaVersion`、`outputKind`、`status`、`exitCode` 和结构化 `diagnostics`，原有业务字段与 `errors` 字符串数组继续保留。帮助、版本和错误也支持 `--json`。详细约定、错误代码与接入流程见 [CLI 输出文档](docs/CLI.md) 和 [JSON Schema](docs/cli-output.schema.json)。CLI 公共字段不改变本地运行记录格式。

`begin --task <需求>` 保存任务开始时的实际 JS/TS 源码、内容哈希、配置、重要项目清单的哈希与可用的 HEAD。它包含已跟踪和未跟踪文件，不要求工作区干净，也支持尚无提交的 Git 仓库。缓存保存在目标项目的 `.terse/runs/<id>/`，建议将 `.terse/` 加入目标项目的 `.gitignore`；工具自身始终排除这个缓存目录。

`begin --query <关键词> [--limit 5]` 额外执行现有检索，不需要再重复调用 `context`。检索错误使本次输出为 `incomplete`，基线 run 仍会返回；不会自动选中候选或生成复用理由。

`context --run <id> --query <关键词>` 提取函数、类、方法及类型声明，按名称、路径和源码内容排序。结果包含源码位置、内容哈希、限长片段、相对路径与别名导入关系及按名称匹配的测试。每个候选新增 `candidateId`，绑定源码位置和内容，供 `decide --candidate` 使用，不依赖搜索排序。默认最多 5 个候选，可用 `--limit 1..20` 调整。中文关键词可匹配中文注释；源码没有相关中文时请补充英文业务词或符号名。空结果不代表没有可复用实现。搜索证据会保存在 `context.json`。

`decide --run <id> --strategy <reuse|modify|refactor|new> --rationale <理由> [--candidate <id>]` 校验并保存完整决策。候选可重复传入；策略 reuse 默认将候选标为 reuse，modify/refactor 默认为 modify，new 默认为 reject。`--reason` 默认复用所填 rationale，可用 `--disposition` 明确调整；`--remove <路径>` 声明文件删除。new 可不选候选，其他策略至少需要一个未拒绝的基线候选。需要先有对基线的成功检索。保存成功只说明记录有效，不代表项目通过，也不免除重复检查。

复杂记录使用 `decide --run <id> --input <file> [--candidate <id>]`。input 是完整决策；candidate 在此仅校验基线 ID 已出现在 input.considered，不追加或覆盖记录。因此 p-queue 中冗余携带正确候选 ID 的调用可以直接成功。其他决策标志（strategy、rationale、disposition、reason、remove）仍与 input 互斥，返回逐字段 conflict 提示；未知、失效或未列入输入的候选仍拒绝写入。细节见 [CLI 输入契约](docs/CLI.md#决策与低往返接入)。

`begin/context/decide` 返回可直接执行的 `verificationGuide.argvTemplate`，以 `check` 作为最终验证入口。默认不在 check 前后手动重复执行已配置的整套测试；单项调试和未配置的额外检查仍可按需执行，修复或相关输入、环境变化后重新执行完整 check。begin --query 已包含首轮检索，无需为同一批候选再调用 context。

`check --summary` 仍执行完整检查与配置的验证，不使用缓存或跳过验证；JSON 省略 `verification[].output`，以 `outputOmitted: true` 标记。失败或启动错误项提供 `failureOutput` 和 `failureOutputTruncated`（每项最多 2,048 个 JS 字符单位、总计 4,096），供当前响应内诊断；不足时读取 `reportPath` 中原有完整报告。状态、退出码、发现和执行错误保持可见；默认输出不变。决策形状错误另提供 `decisionIssues`，避免用笼统的待评估消息猜字段。

`check --run <id>` 比较当前代码与任务基线，使用 jscpd 的 token 检测核心寻找新增或扩大的重复片段，检查决策中的候选与删除目标，并执行基线配置中的验证命令。完整结果写入 `report.json`，包括扫描文件数、排除范围、错误、验证输出、发现位置与快照标识。`--json` 返回同样的机器可读结果。

`--skip-verification` 可显式跳过验证，但会产生 `needs-review`。配置中没有验证命令也不能得到 `pass`。检查期间源码或项目清单发生变化时，结果为 `incomplete`，需要重新检查。

## 基线校验与恢复

`context` 和 `check` 通过同一个 `loadRun` 读取基线。M1 会先验证记录结构、运行身份、仓库与分析器版本、配置、源码与清单哈希及排除记录，再核对整个快照的哈希。损坏记录在分析和执行验证命令之前被拒绝，CLI 保持退出码 `3`、`status: incomplete` 与 `errors` 数组，并沿用 M5 的 `COMMAND_ERROR`，通过 `diagnostics[].causeCode` 提供以下错误类别，无需解析消息文本。

错误信息包含文件位置和可定位的字段，并区分以下情况：

- `JSON_READ_FAILED`：文件缺失、无法读取、不是普通文件或无法按 UTF-8 解码。读取记录时不跟随文件符号链接。
- `INVALID_JSON`：文件内容不是有效 JSON，错误中不会回显文件内容。
- `BASELINE_INVALID`：字段类型、配置、相对路径或哈希格式不符合记录要求。
- `BASELINE_INCOMPATIBLE`：schema、分析器、run ID 或仓库与当前运行不匹配。
- `BASELINE_INTEGRITY`：源码内容与其哈希不符，或快照整体与保存的哈希不符。
- `INVALID_RUN_ID` / `RUN_NOT_FOUND`：传入的运行标识无效，或本地不存在对应运行目录。

修复时优先恢复原始记录，或使用 `begin` 开始新任务，不要通过重算哈希掩盖记录损坏。新任务以当前工作区为起点，不会还原旧任务开始时的代码。读取基线失败时不会生成新的检查报告；已有 `report.json` 仅代表之前那次检查，不能替代本次错误结果。

本次保持 schema 1 和既有分析器标识，合法的 v0.1 基线仍可读取。JSON 对象字段的排列和缩进不会改变校验结果；源码内容或配置变化仍需要正确处置。校验用于发现结构与内容不一致，不是数字签名，无法证明本地记录未被有意修改。

## M2：导入与路径别名

`context` 从每个源文件所在目录向上查找最近的 `tsconfig.json` 或 `jsconfig.json`，同目录优先使用前者，并止于 Git 根目录。复用 TypeScript 5.9 的配置与模块解析 API，支持 `baseUrl`、`paths` 的精确匹配、通配符与多个候选路径，以及仓库内配置继承。无配置时使用 Node10 解析规则；配置了 NodeNext 时保留其 ESM/CJS 区别。路径别名只帮助查找源码，不改变项目运行时的导入行为。

例如在根目录的 `tsconfig.json` 中配置：

```json
{ "compilerOptions": { "paths": { "@orders/*": ["./src/orders/*"] } } }
```

`import { exportOrders } from '@orders/export'` 可关联到 `src/orders/export.ts`。候选的 `imports` 和 `importedBy` 保留原始引用、文件位置、解析目标及使用的配置。覆盖静态 import、export 转发、import equals、import type、字符串形式的 require 和动态 import；这仍是语法关系，不是精确调用图，也不判断局部 require 是否遮蔽了 Node 的 require。

JSON 结果新增顶层 `unresolvedImports`，即使没有匹配候选也会返回；普通文本输出同样显示这些引用。`reason` 包括 `dynamic-expression`、`config-error`、`not-found-in-snapshot`、`outside-source-snapshot`。未解析的包、内置模块、排除文件或动态表达式不会被伪装成有效源码目标，也不单独导致命令失败。

未找到当前或基线源码目标的字面量包导入，可以带可选的 `externalDependency: { "package": "eventemitter3", "manifest": "package.json" }`。该证据来自哈希核对过的最近项目清单中的依赖声明；导入仍保留在 `unresolvedImports`，不保证依赖已安装、子路径可导出或包的类型有效。历史索引不读取实时清单。

配置读取仅允许快照中已有哈希的 `tsconfig*.json`、`jsconfig.json` 和项目清单，并核对实时内容。继承链暂不支持任意名称的 JSON（例如 `configs/base.json`）、依赖包配置或仓库外配置；可使用 `configs/tsconfig.base.json`。无效或不支持的配置产生 `IMPORT_CONFIG` 错误，配置读取或哈希不一致产生 `IMPORT_METADATA`，命令退出码为 3，且不能作为成功的基线检索证据。搜索期间项目变化同样要求重新运行。

源码覆盖仍由 Terse 的扫描规则决定，不使用 tsconfig 的 include/exclude 来缩小检索；不遍历 project references，也不自动选择 `tsconfig.app.json` 等变体入口。Vite/Webpack 自定义别名、工作区包链接及完整依赖包解析留待后续。实现集中在 `src/imports.ts`，供现有索引流程调用；历史基线的符号检查不读取当前工作区配置，基线格式保持不变。

## 决策、配置与退出码

`strategy` 可选 `reuse`、`modify`、`refactor`、`new`。前三种至少需要一个 `reuse` 或 `modify` 的已有候选；`new` 可以在确实没有候选时使用空列表。`considered` 中的 `disposition` 可选 `reuse`、`modify`、`reject`，每项均需具体理由。候选必须存在于基线中。

`remove` 可以填写 `{ "path": "src/legacy.ts" }` 或 `{ "path": "src/orders.ts", "symbol": "oldExport" }`。声明删除的对象仍存在时检查失败。M4 还会检查已删除对象的可解析引用，详见下方范围说明。

### M4 清理与残留引用

检查只针对 `decision.json` 中的删除声明。文件删除后，当前源码中仍指向该文件的相对路径或 M2 支持的别名 import、export 转发、字符串动态 import 等产生 `REMOVAL_REFERENCE_REMAINS`，状态为 `fail`。报告位置首先列出残留引用所在文件和行号，再列出删除目标；新添加的消费者也会被检查。路径解析复用 M2 的 TypeScript 解析器，优先完成当前配置下的全部候选查找；仅在当前解析失败时使用基线源码文件作为定位线索，不把基线消费者当成当前残留。当前存在的替代目标或别名重映射优先，不会因旧目标已删除而误报。

符号删除支持直接具名导入/转发、导入别名、默认导出和具名类型导入。通过 TypeScript 的局部绑定追踪 `export { oldName as publicName }`，避免仅按文本名称匹配。若当前模块用其他实现保留了同一个导出名称，不认定消费者已经失效；若改为转发另一模块，则要求评估转发链。对同文件顶层声明，还检查删除后未绑定的直接调用、构造调用和局部导出语句，排除参数遮蔽和显式导入的替代绑定。其他脚本中的同名全局声明不会被当作该文件的替代实现。

以下发现要求 `needs-review`，不会把未知情况当作已完成清理：

- `REMOVAL_REFERENCE_UNCERTAIN`：namespace、星号转发、require、动态 import 的符号使用、不能确认的成员/嵌套声明删除，或可能的转发替代。require 可能是局部自定义函数，因此仅凭语法不判定其调用已失效。
- `REMOVAL_REFERENCE_UNRESOLVED`：存在无法确认归属的本地路径、别名、未声明包、非内置 require 或动态表达式。已知 Node 内置模块，以及带上述外部依赖证据的普通导入，不会单独触发此提示；非内置 require 仍保留复核，因为它可能被局部替换。
- `REMOVAL_NOT_VERIFIED`：目标仍列在跳过文件中；离开扫描范围不能证明文件已删除。
- `REMOVAL_TARGET_UNKNOWN`：声明的对象不在基线；`REMOVAL_REMAINS` 则表示声明删除的实现仍存在，属于失败。

同一文件中唯一命名顶层类的 ECMAScript `#` 私有方法，现可按词法范围确认清理：旧私有名与引用均消失时不再一律复核；残留调用、读取和品牌检查仍失败。嵌套类遮蔽按私有环境处理，直接 eval、装饰器与无法匹配的类仍需复核。公共成员和 TypeScript `private` 不使用此结论，全部配置验证继续执行。边界与历史回放见 [私有方法清理](docs/PRIVATE-CLEANUP.md)。

M4 已适配 M2：`indexSources(state, root?, fallbackFiles?)` 保留第二个参数作为项目根目录，第三个可选参数提供基线源码定位候选。导入记录复用 `ImportReference`，补充导入名称、require 标记及 `targetSnapshot: current | baseline`。`context` 不传基线候选，只报告当前目标；`check` 使用当前配置查找当前消费者，历史基线符号分析不读取实时配置。基线回退不读取旧配置或旧 package.json，配置继承和覆盖边界与 M2 一致；不能解析的别名仍要求评估。配置读取或解析失败时，`check` 返回 `incomplete`，不执行验证命令。

外部依赖证据只接受最近 `package.json` 的 dependencies、devDependencies、peerDependencies、optionalDependencies 中普通版本/范围/tag 声明。匹配 paths、启用 baseUrl、同名本地包、工作区标记、本地/协议依赖（含 npm 别名）、不合法或未覆盖的清单都不能用作免复核依据；最近包未声明时不向父包借用声明。现有解析器先检查当前与基线源码，能定位的残留引用、未覆盖目标、成员引用不确定性继续按原规则处理。该判断限定于 M2 已覆盖的配置，不解析额外的 bundler 别名。

清理规则集中在 `src/cleanup.ts`，路径解析统一复用 `src/imports.ts`，已删除 M4 的手写路径候选逻辑。沿用既有快照、发现结构、验证命令和退出码，不增加依赖或修改基线格式。

这不是完整引用图或类型检查：不递归证明 barrel 导出链，不分析仓库外消费者、配置字符串、反射和任意计算属性；同文件检查目前只覆盖上述直接语法，不证明回调传递等所有使用均已清理。请同时配置项目自身的类型检查和测试。没有删除声明时不会触发这些清理规则。

`exclude` 使用相对于 Git 根目录的文件或目录前缀，以 `/` 分隔，不支持 glob。默认排除依赖、构建输出、覆盖率目录、声明文件、压缩 JS 和 Terse 缓存。超过 1 MiB、非 UTF-8、二进制或符号链接源文件会报告覆盖缺口；不跟随符号链接。

`minTokens` 至少为 10，`minLines` 至少为 1。`duplicatePolicy` 默认 `review`，表示新重复需要评估；设为 `fail` 可以阻断符合检测规则的新重复。相似代码仍可能承担合理的独立职责，首版没有自动豁免或语义合并功能。

验证通过独立的 `command` 与 `args` 执行，不启用 shell，不解析 `&&` 或重定向。`node` 会使用运行 Terse 的 Node 可执行文件。在 Windows 上需要运行 npm 脚本时，可显式配置 Node 加 npm CLI 路径，或配置实际检查器的 JavaScript 入口；不要把整个命令行塞进 `command`。单条命令超时默认 30 秒，可配置为 100 毫秒至 300 秒。

配置在 `begin` 时固定；任务期间配置变化会使检查未完成。修改配置后，应评估变化并开始新 run。首版是本地辅助工具，不将这份本地状态视为防篡改的合并凭据。

- `0 / pass`：规定检查完成且无待处理项，结论只针对记录的快照和分析范围。
- `1 / fail`：验证失败、声明删除未完成、发现确定范围内的残留引用，或触发配置为失败的新重复规则。
- `2 / needs-review`：有新增重复、决策或检索记录缺失、验证缺失或覆盖缺口。
- `3 / incomplete`：参数、解析、存储、检测器或验证启动错误，策略变化，超时，或检查期间代码变化。

## 给 agent 的工作约定

可以将以下步骤加入任务说明：

1. 修改代码前执行 `begin`，确定功能验收条件。
2. 执行 `context`，阅读候选源码、相关调用位置和测试；必要时换关键词继续查找。
3. 使用 `decide` 记录复用、修改或新增的理由和计划删除对象；复杂记录可用 input 文件，既有手写记录仍支持。
4. 实施需求并处理被替代代码。
5. 执行 `check`，处理实际问题，并在源码变更后重新验证。
6. 交付时说明复用了什么、为何新增、清理了什么、哪些验证完成或仍有缺口。

工具返回过代码不代表 agent 已理解代码。`init` 安装的项目 Skill 和指令会提供上述行为引导；当前没有接管编辑工具、强制宿主 hook 或 CI 合并门槛。

## 分析范围与后续方向

M3 现增加 [改写式实现复核](docs/SIMILARITY.md)：连续 token 没有匹配时，仍可根据函数共有的有效字面量、数据属性和成员操作提示 POSSIBLE_DUPLICATION。已知 CSV 改写反例会从 pass 转为 needs-review，改为委托已有实现后通过；相似证据不等于语义等价。

报告新增 similarityAlgorithm 和 possibleDuplications，后者统计可能重叠的函数对；newDuplications 仍仅计原有 token 序列组。该提示始终为 review，完整行为验证和严格 token 策略保持原有语义。短函数、缺少共同锚点等情况仍可能漏报，独立职责也需结合证据审查。

重复检测复用 [jscpd 的 Node API 组件](https://github.com/kucherenko/jscpd/blob/master/README-v4.md)，只安装检测核心和 tokenizer。它忽略空白与注释，保留标识符和字面量；首版不做变量改名归一化、跨语言语义检测或自动合并。不同 tokenizer 格式间的重复可能漏报。

M3 对当前检测到的每个重复片段，核对其完整 token 序列在基线和当前源码中的出现次数。出现次数没有增长时不报新增，因此旧片段的拆分、缩短、换行、注释调整和移动不会仅因片段指纹改变而触发新增发现。新片段形成至少两处重复，或已有片段增加副本时，仍按 `duplicatePolicy` 返回待评估或失败。

检测结果会先核对两侧 token，修正检测窗口多带的末尾 token，并重新检查长度和行数阈值。同一 token 序列的检测匹配合并为一条 `NEW_DUPLICATION`，`locations` 可以包含两个以上位置。`newDuplications` 是新增重复序列组数；`baselineClones` 和 `currentClones` 是通过边界校验的匹配对数，三者不应直接相减。每条发现新增 `attribution`：

- `kind`：`new-or-expanded` 表示该完整序列在基线中不足两处，`additional-copy` 表示已有重复的出现次数增加。
- `baselineOccurrences` / `currentOccurrences`：完整 token 序列在两份源码快照中的出现次数，包含同文件及重叠出现，不等同于函数数量。
- `files`：检测器提供的位置涉及哪些文件，以及相对基线属于 `added`、`modified` 或 `unchanged`。这不是作者归因，也不保证某个具体位置就是新增来源。

报告通过 `attributionAlgorithm: "token-occurrences/1"` 标识此归因算法。基线 schema 和分析器依赖标识不变，读取旧 run 时会用保存的源码重新分析，不复用旧的重复检测结果。内部 `newClones` 接口改为接收前后 `Snapshot` 和当前 `Clone[]`，统一由 `check` 调用；`clones` 保留检测器并增加来自完整文件词法上下文的 token 序列，无新增依赖。

这是基于内容与数量的归因，不是完整编辑历史：删除一个副本再在别处添加相同内容，与移动无法可靠区分；净出现次数不增加时不会报告新增。检测范围仍受 jscpd 阈值及 tokenizer 格式影响，也不做变量改名或语义等价判断。每个不同片段扫描前后 token 流，当前没有大型仓库性能承诺或持久化索引。

源码结构与导入解析复用固定版本的 [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)，别名遵循 [paths](https://www.typescriptlang.org/tsconfig/paths.html) 与 [extends](https://www.typescriptlang.org/tsconfig/extends.html) 的配置语义及上述覆盖范围。当前进行语法解析与词法检索，尚不提供完整类型检查、精确符号调用图或业务职责判断；项目可以配置自身的类型检查与测试命令。

工作区被其他进程同时编辑时，只能报告任务期间的变化，不能证明每处改动来自哪个 agent。验证输出会截断到 12,000 字符；命令失败和输出超限不会被算作通过。缓存含项目源码，保留在本地，不自动上传。

后续优先扩展真实项目评测、符号引用与清理检查、例外处置，再根据需求添加 MCP。当前原型不包含完整的补丁叠加或业务职责检测。
