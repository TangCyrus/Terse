# CLI 输出契约 v1

Agent 应通过参数数组运行 `node <terse>/dist/cli.js <command> ... --json`，不要拼接 shell 命令。完整 JSON Schema 见 [cli-output.schema.json](cli-output.schema.json)。本版定义 CLI 的公共字段和必需业务字段，不是 MCP 或稳定的库调用 API。

## 读取规则

`--json` 模式每次向 stdout 输出一个 JSON 对象和结尾换行，可能跨多行；应在进程退出后解析完整 stdout，不要按行拆 JSON。正常的工具诊断也包含在 JSON 中，不写入 stderr；项目验证命令的输出保存在 `verification[].output`。进程被外部终止、stdout 管道断开或 Node 无法启动不保证产生 JSON，宿主应单独处理这类传输失败。

所有命令、帮助、版本和捕获到的错误均包含以下字段：

| 字段 | 约定 |
| --- | --- |
| `schemaVersion` | 当前为数字 `1`，不随工具版本改变 |
| `toolVersion` | Terse 版本字符串 |
| `command` | `begin`、`context`、`check`、`help`、`version`；参数解析尚未识别命令时为 `null` |
| `outputKind` | `result` 表示命令已返回结果；`error` 表示参数、项目定位或执行异常，可能没有任何业务字段 |
| `status` | `pass`、`fail`、`needs-review`、`incomplete` |
| `exitCode` | 与实际进程退出码一致：依次为 `0`、`1`、`2`、`3` |
| `errors` | 保留兼容的字符串数组；没有执行错误时为空 |
| `diagnostics` | 结构化执行诊断数组；没有执行错误时为空 |

`begin/context/help/version` 的 `pass` 仅表示该命令完成，不是项目验收通过，也不证明 agent 理解或复用了代码。`result` 也可能是 `incomplete`，例如源码解析失败的检索或检查结果。`check` 的规则失败和待评估项位于 `findings`，此时 `diagnostics` 可以为空；应先判断 status/exitCode，再读取 findings 和 diagnostics。

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

## Agent 调用顺序

1. begin 成功后保存 run 和 decisionPath。
2. context 成功后阅读 candidates、unresolvedImports 和 limitations，再填写 decision.json。
3. 修改后执行 check；退出码 1/2/3 都需要处理，不因拿到 JSON 就判定完成。
4. 记录 snapshotHash；工作区变化后重新验证。错误输出不保证包含 run、快照或报告路径，只有确认 outputKind 为 result 后才能读取对应命令的必需业务字段。
