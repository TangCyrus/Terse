# CLI 输出契约 v1

Agent 应通过参数数组运行 `node <terse>/dist/cli.js <command> ... --json`，不要拼接 shell 命令。完整 JSON Schema 见 [cli-output.schema.json](cli-output.schema.json)。本版定义 CLI 的公共字段和必需业务字段，不是 MCP 或稳定的库调用 API。

## 读取规则

新增 `init [--verify <command JSON>] [--cwd <project>] [--json]` 安装项目 Skill 与配置，不建立任务基线、不执行验证。verify 可重复传入 command/args/可选 timeoutMs 对象，只用于新配置。已有配置保留，冲突或不安全路径返回既有错误结构。结果包含 root、skillPath、instructionsPath、runnerArgv、files、verificationConfigured、setupIssues 和 next；files 的 status 为 created / updated / unchanged / preserved。无验证时为 needs-review / 2；有配置时 pass 只表示安装完成。init 不返回任务 verificationGuide。详细行为见 [Agent 接入](AGENT-INTEGRATION.md)。

`--json` 模式每次向 stdout 输出一个 JSON 对象和结尾换行，可能跨多行；应在进程退出后解析完整 stdout，不要按行拆 JSON。正常的工具诊断也包含在 JSON 中，不写入 stderr；项目验证命令的输出保存在 `verification[].output`。进程被外部终止、stdout 管道断开或 Node 无法启动不保证产生 JSON，宿主应单独处理这类传输失败。

所有命令、帮助、版本和捕获到的错误均包含以下字段：

| 字段 | 约定 |
| --- | --- |
| `schemaVersion` | 当前为数字 `1`，不随工具版本改变 |
| `toolVersion` | Terse 版本字符串 |
| `command` | `init`、`begin`、`context`、`decide`、`check`、`help`、`version`；参数解析尚未识别命令时为 `null` |
| `outputKind` | `result` 表示命令已返回结果；`error` 表示参数、项目定位或执行异常，可能没有任何业务字段 |
| `status` | `pass`、`fail`、`needs-review`、`incomplete` |
| `exitCode` | 与实际进程退出码一致：依次为 `0`、`1`、`2`、`3` |
| `errors` | 保留兼容的字符串数组；没有执行错误时为空 |
| `diagnostics` | 结构化执行诊断数组；没有执行错误时为空 |

`begin/context/decide/help/version` 的 `pass` 仅表示该命令完成，不是项目验收通过，也不证明 agent 理解或复用了代码。`result` 也可能是 `incomplete`，例如源码解析失败的检索或检查结果。`check` 的规则失败和待评估项位于 `findings`，此时 `diagnostics` 可以为空；应先判断 status/exitCode，再读取 findings 和 diagnostics。

新增公共字段时 schemaVersion 可以保持不变，消费者应忽略未知字段；删除或改变既有公共字段含义需要提升 schemaVersion。业务载荷保留原有顶层位置，不迁入 `data`。Schema 要求每个结果的关键业务字段存在，但不穷举或冻结所有嵌套字段。没有输出或不支持的 schemaVersion 应由宿主作为协议错误处理，不能当作通过。

## 错误结构

每个 diagnostic 含 `code`、`message`、`stage`，底层异常提供字符串代码时额外包含 `causeCode`。`message` 供人阅读，不保证措辞稳定；不要解析其中的英文文本来决定行为。每条 diagnostic.message 对应 errors 中同位置的字符串。不会输出错误堆栈或原始异常对象。

| code | stage | 含义与处理 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `arguments` | 参数解析、缺少必需参数或非法选项；修正命令后重试 |
| `PROJECT_ERROR` | `project` | 无法定位 Git 项目，例如 cwd 不存在或不在仓库；检查路径与 Git 环境 |
| `COMMAND_ERROR` | `command` | 执行中抛出的异常，如 run 不存在、记录损坏、配置或存储失败；查看消息并修复原因 |
| `CONTEXT_INCOMPLETE` | `command` | context 返回分析错误；保留候选等部分结果，但不能作为成功检索 |
| `CHECK_INCOMPLETE` | `command` | check 返回未完成原因，如解析错误、超时、验证启动失败或快照变化；处理后重新检查 |

这些是首版按阶段划分的稳定代码，并不声称能细分所有底层故障。`causeCode`（如 ENOENT）是补充信息，其取值可能取决于 Node、操作系统或子进程。修复 run 记录前保留原始证据；不要把一次命令异常当作空发现列表。缺少必需参数的检查先于 Git 项目定位。

M1 基线读取失败沿用 `COMMAND_ERROR` 和 `stage: "command"`，通过 `causeCode` 提供错误类别：`JSON_READ_FAILED`、`INVALID_JSON`、`BASELINE_INVALID`、`BASELINE_INCOMPATIBLE`、`BASELINE_INTEGRITY`、`INVALID_RUN_ID` 或 `RUN_NOT_FOUND`。JSON 读取错误也可能来自配置等记录，应结合消息中的文件位置定位。此时 `outputKind` 为 `error`、退出码为 3，不生成新的检查报告，也不执行验证命令；具体恢复方式见 README 的“基线校验与恢复”。

`decide` 的记录格式、候选或前置证据错误使用 `COMMAND_ERROR`，`causeCode: "DECISION_INVALID"`，并提供 `diagnostics[].issues`。每项含 `field`、`code`、`message`，例如 `field: "considered[0].disposition"`；不需要读源码或解析英文报错。issue code 包括 `invalid`、`required`、`not-found`、`not-considered`、`parse-error`，未来可扩展。`not-considered` 表示候选 ID 属于基线，但 input.considered 没有该 path/symbol。真正冲突的 input 参数组合使用 `INVALID_ARGUMENT` / arguments，并在 issues 中逐项给出 `code: "conflict"` 和字段名，先于项目定位或读取 input。核心 decide API 同样拒绝冲突，不静默忽略参数。JSON 读取或解析错误仍沿用 M1 causeCode。拒绝写入时保留原 decision，且不执行项目验证。

直接编辑记录仍可用于既有工作流。`check` 复用同一形状校验器，格式不完整时保留 `DECISION_MISSING` 待评估发现，并附顶层 `decisionIssues`；无效 JSON 仍是执行异常。默认检查的状态优先级和验证行为不变。

例如缺少 task：

```json
{
  "schemaVersion": 1,
  "toolVersion": "0.1.0",
  "command": "begin",
  "outputKind": "error",
  "status": "incomplete",
  "exitCode": 3,
  "errors": ["--task is required"],
  "diagnostics": [{ "code": "INVALID_ARGUMENT", "message": "--task is required", "stage": "arguments" }]
}
```

## 帮助、版本与兼容

`--help --json` 返回 `command: help` 和 `help` 文本字段；`--version --json` 返回 `command: version`，版本读取 toolVersion。无命令时保留显示帮助的行为，同时传 help/version 时 version 优先；未知选项仍先被参数解析拒绝。不加 `--json` 时保留面向人的文本输出，文本布局不属于稳定协议。

`baseline.json`、`context.json` 和 `report.json` 保持原有存储格式；CLI 在业务结果外添加公共字段，但不改写持久化报告。若读取 report.json，应按其原有报告结构处理，不能假设它包含 schemaVersion 或 diagnostics。本版不改变基线版本、检测阈值或状态优先级，也不新增依赖。

## 决策与低往返接入

推荐以参数数组调用三步流程（需求实现发生在第 2 步之后）：

1. `begin --task <需求> --query <关键词> --json`。同一调用中建立基线并执行既有 `context`；返回 `context` 嵌套载荷、`decisionGuide` 和建议的下一步。嵌套 context 是核心检索载荷，不额外套 CLI 公共字段。失败检索返回 `incomplete`、`CONTEXT_INCOMPLETE` 和已建立的 run；不能把它当作成功证据。`--limit` 可与 query 配合，未给 query 时禁止单独使用 limit。
2. 阅读候选并明确选择，用 `decide --run <id> --strategy <策略> --rationale <理由> --candidate <candidateId> --json` 记录。`candidateId` 来自检索返回，绑定路径、符号、行号和源文件哈希，不随排序或关键词变化；编辑后产生的新 ID 不能当作旧基线候选。`decisionGuide` 保留简单记录的 argvTemplate，另提供可直接使用的 inputArgvTemplate、inputCandidateRole: assertion、inputExclusiveFlags 及已打包的形状 schema 路径。复杂记录应使用 input 模板，不在简单模板上叠加 input。
3. 修改后执行 `verificationGuide.argvTemplate`，等价于 `check --cwd <root> --run <id> --summary --json`。执行完整检查和验证，省略完整验证日志并保留失败摘要；处理所有非零退出码。

`begin/context/decide` 的 CLI 结果均附顶层 `verificationGuide`（不写入基线或决策文件）。`argvTemplate` 为可直接追加到 `node <terse>/dist/cli.js` 后的参数数组，已填充规范化 root/run，无占位符；`verificationOwner: "check"` 表明由 check 执行 begin 固定的全部验证。`notes` 提供调用提示，不应作为机器状态解析。已有 begin --query 结果可直接用于决策，只有需要更多候选时才再次 context。

以 check 作为最终验证入口，默认不在它前后手动重跑同一组配置命令。先看失败摘要、errors 和 findings；确需定位时可运行单项诊断或未配置的额外检查，修复后仍须重新执行完整 check。验证均通过但存在 review 发现时，应评估该发现，重复执行未变化的测试不能消除它。任何相关源码、非源码输入、依赖或环境发生变化后均应重新检查。每次 check 都重新分析并执行验证，不缓存成功结果或增加跳过入口。

`decide` 是显式写操作，替换完整 decision，不隐式合并旧候选或删除列表。`--candidate` 可重复传入，重复 ID 去重；所有候选默认使用同一 disposition 和 reason：strategy reuse→reuse，modify/refactor→modify，new→reject；reason 默认等于实际填入的 rationale。可分别用 `--disposition`、`--reason` 覆盖。它们需要 candidate；未选候选时只有 new 策略可保存。`--remove <repo-relative-path>` 可重复，用于整文件删除声明。

复杂记录使用 `decide --run <id> --input <文件> --json`，input 相对 Git 根目录解析，也允许显式绝对路径。文件是完整决策，保留每个候选单独的处置/理由、`{path, symbol}` 删除目标及扩展字段。可选的一个或多个 `--candidate <id>` 只作断言：每个 ID 必须属于该 run 的基线，其 path/symbol 必须已经列在 input.considered 中；重复 ID 去重，不追加候选、不改变 reject、不生成理由或覆盖删除声明。输入中未通过标志列出的其他候选仍完整保留。

input 不能与 `--strategy`、`--rationale`、`--disposition`、`--reason`、`--remove` 混用；这些值应写在文件中。命令不会把两种来源隐式合并。形状见 [decision.schema.json](decision.schema.json)，决策文件格式本身不变；命令仍验证每个候选存在、非 new 策略有未拒绝候选、基线检索成功。候选断言不代替完整格式或前置条件校验。

`decisionGuide.removalGuide` 说明文件与符号删除的形状。原地修改允许空 remove；退役的文件、已索引路径/名称则须声明。check 对观察到的遗漏返回 `REMOVAL_DECLARATION_MISSING` / fail / 退出码 1，并在完整、summary 及落盘报告提供 `undeclaredRemovals`。该约束不依赖 strategy，推导目标仍进入 M4 引用检查，全部配置验证照常运行。读取原 decision，在同一 run 用完整 input 保留并补全声明，再完整复验；不以重新 begin 隐藏遗漏。补全后残留引用仍失败，不确定引用仍 review。范围、兼容边界及示例见 [删除声明约束](REMOVAL-DECLARATIONS.md)。Baseline.schema、Decision 形状、CLI schemaVersion 和既有归因算法不变。

合法旧 run 无需迁移基线：工作区仍匹配基线时可再次 context 获得 ID；已经修改时，可保留原成功检索证据并用 input 引用基线中的 path/symbol。旧检索历史没有 ID 字段不因此失效；不带 candidate 的原有 input 用法继续支持，编辑后的新 ID 不能冒充旧基线候选。

保存成功返回 `run`、`decisionPath`、`decision` 和 `next`，不自动选择第一个候选，不生成理由，也不消除重复发现。候选 ID 和本地证据是定位辅助，不是防篡改凭据。

`--summary` 是 check 的选择性呈现方式：返回 `detail: "summary"`、`reportPath`，每个 verification 保留命令、状态、退出码和执行错误，省去 `output` 并设 `outputOmitted: true`。仅 failed/error 项增补 `failureOutput` 与 `failureOutputTruncated`：每项最多 2,048 个 JS 字符单位，按命令顺序共享 4,096 的总预算，长日志保留开头和结尾，中间加省略标记。预算不足时后续摘要可能为空；Truncated 表示相对持久化 output 发生删节，不能据此推断原始进程输出是否超过原有 12,000 上限。passed 项不含这两个字段。

全部 findings、errors 和 diagnostics 保留；启动错误或超时仍在 error/errors 中，即使摘要预算耗尽也不会被隐藏。摘要不足以诊断时可读取 reportPath，原有报告及其日志长度上限不变，不包含 failureOutput。默认未指定 summary 时，既有完整 JSON 输出不变。不使用结果缓存，不跳过验证，也不把无日志正文解释为没有输出。

## Agent 调用顺序

check 兼容性增加 similarityAlgorithm: implementation-anchors/1、possibleDuplications 及发现规则 POSSIBLE_DUPLICATION。每条发现携带两个函数位置和 similarity 的共有字面量/属性/操作列表、两侧锚点数与共有锚点数；列表每类最多 20 项，evidenceTruncated 标记删节，计数仍为完整数量。详情见 [实现复核](SIMILARITY.md)。

possibleDuplications 是需复核的函数对数，不代表已证明的语义重复；newDuplications 与 attributionAlgorithm 的原有 token 含义不变。此规则始终 review，即使 duplicatePolicy 为 fail；独立权限或职责可能合理。Agent 应审查具体证据与需求，在保留行为测试的前提下复用、抽取或说明差异。summary 与持久化报告均保留发现，检查及验证不跳过。

1. begin 成功后保存 run 和 decisionPath；可用 query 合并首轮检索。
2. 检索成功后阅读 candidates、unresolvedImports 和 limitations，再用 decide 保存实际决策；需要时继续 context。
3. 修改后执行 check，可选 summary；退出码 1/2/3 都需要处理，不因拿到 JSON 就判定完成。
4. 记录 snapshotHash；工作区变化后重新验证。错误输出不保证包含 run、快照或报告路径，只有确认 outputKind 为 result 后才能读取对应命令的必需业务字段。
