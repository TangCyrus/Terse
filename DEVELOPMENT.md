# Terse 开发文档

本文用于开发 Terse 本身：说明当前代码归属、模块接口、验证方式，以及按模块交付的顺序。产品使用方式见 [README.md](README.md)，长期目标与设计取舍见 [DESIGN.md](DESIGN.md)。

当前版本为 v0.1.0。本文以 `main` 的 `4ad831a` 为开发起点，M1–M6 首轮、项目评测 #8、p-map 实际 agent 评测 #9、M5 决策接入优化 #10、p-queue 评测 #11、M4 外部依赖清理优化 #12、M5 复杂决策优化 #13 和 p-queue 优化后复测 #14 均已合并；起点的 Windows/Linux Node 24 CI 各通过 129 项测试（含子用例）及打包预检。后续数量以各提交 CI 为准。产品仍是本地 CLI，模块首轮完成不表示长期设计中的全部能力已实现。

| 模块 | 已合并的首轮交付 | PR |
| --- | --- | --- |
| M1 | 持久化基线结构、整体哈希校验与错误诊断 | [#3](https://github.com/jinyangtang33-sys/Terse/pull/3) |
| M2 | 导入与路径别名解析 | [#4](https://github.com/jinyangtang33-sys/Terse/pull/4) |
| M3 | 重复片段边界校验与 token 出现次数归因 | [#5](https://github.com/jinyangtang33-sys/Terse/pull/5) |
| M4 | 声明删除与残留引用检查，适配 M2 | [#6](https://github.com/jinyangtang33-sys/Terse/pull/6) |
| M5 | CLI 输出契约 v1 与结构化错误 | [#7](https://github.com/jinyangtang33-sys/Terse/pull/7) |
| M6 | Windows/Linux 构建、测试与打包预检 | [#2](https://github.com/jinyangtang33-sys/Terse/pull/2) |

已合并的 [项目评测](docs/EVALUATION.md) 有 6 个场景、10 个实现变体，包含四类任务及独立职责、动态引用反例。[p-queue 实际 agent 评测](docs/COMPLEX-AGENT-BENCHMARK.md) 的首轮与优化后复测各包含三个任务、12 次会话。本次 M5 交付针对复测中重复执行整套验证及失败 summary 缺少日志的问题；真实 agent 的整体耗时收益仍需后续同条件复测。

## 开发原则与任务范围

一个开发任务围绕一个明确结果展开，确定主模块后，先检查该模块及直接依赖中的已有能力。优先在已有职责归属处修改，新增文件、依赖、抽象或兼容分支需要说明具体用途，并清理被替代的路径。

模块划分用于明确职责和 PR 范围，现阶段沿用现有文件。一个文件可以承载两个规模较小的职责，例如 `analyze.ts` 中的检索与重复检测；只有真实改动需要独立维护时才提取文件，避免提前创建空目录、接口层或插件框架。

一个 PR 交付一个可验证的改动，不要求整块模块一次做完。跨模块的少量联动可以放在同一个 PR，前提是共同服务同一行为，且能解释接口影响。无关重构另开 PR。

开始任务时写清以下信息，放在任务说明或 PR 描述中即可，无需额外建立一套重复台账：

- 主模块及用户可见的结果。
- 已有实现的位置与拟采用的复用或修改方式。
- 涉及的输入、输出和兼容要求。
- 可检查的验收条件，以及本次明确不处理的范围。

例如：主模块 M2，为 `context` 增加 `tsconfig` 路径别名解析；复用现有导入关系输出；保持未解析引用可见；通过一个别名导入正例和一个解析失败反例验收。这个任务不同时添加向量检索或新的语言支持。

## 当前模块划分

### M1 项目状态与任务基线

代码归属：[src/project.ts](src/project.ts)。共享类型位于 [src/types.ts](src/types.ts)。

输入是 Git 项目位置、项目配置、实际工作区文件和任务描述。输出是源文件快照、内容标识、排除记录、run ID 与本地运行文件。主要入口为 `rootOf`、`configOf`、`snapshot`、`begin`、`loadRun`；`runDir`、`readJson`、`writeJson` 供运行状态读写使用。

这里负责定义“本次任务从哪里开始”和“哪些文件进入分析”，不判断业务上是否应复用。`snapshot` 保存实际工作区的源码内容，包含未跟踪文件；不能退回到仅与 HEAD 比较，否则会把用户原有修改算进本次任务。

现有约束：`.terse` 缓存不参与自身分析；不跟随源文件符号链接；单个文件超过 1 MiB 等覆盖缺口要显式记录；无 HEAD 的空仓库也能开始任务。存储与解析失败不能悄悄当作空结果。

已完成：`loadRun(root, run)` 返回 `{ dir, baseline }` 前校验身份、配置、路径、源码哈希、metadata、排除记录及整体快照哈希。`parseConfig` 和 `snapshotHash` 是内部共用实现；合法 schema-1 记录保持兼容，对象键重排不会改变校验结果。路径按片段校验，允许 `version..backup.js`。

读取失败会抛出带 `code` 的异常，CLI 通过 M5 的 `diagnostics[].causeCode` 提供 `JSON_READ_FAILED`、`INVALID_JSON`、`BASELINE_INVALID`、`BASELINE_INCOMPATIBLE`、`BASELINE_INTEGRITY`、`INVALID_RUN_ID` 或 `RUN_NOT_FOUND`。恢复方式见 [基线校验与恢复](README.md#基线校验与恢复)。损坏基线在分析和验证执行前被拒绝，不生成新报告。哈希用于一致性校验；受信任 CI 凭据、迁移工具等仍待后续需求明确。

### M2 上下文检索与代码结构

代码归属：[src/analyze.ts](src/analyze.ts) 中的 `indexSources` 与 `context`，模块解析集中在 [src/imports.ts](src/imports.ts)。

`indexSources(state, root?, fallbackFiles = {})` 返回 `{ symbols, imports, errors }`。`importResolver(state, errors, root?, fallbackFiles = {})` 创建解析器，由索引流程调用。`context(root, run, query, limit)` 检索当前快照，返回候选、位置、片段、源码哈希、导入关系、相关测试、`unresolvedImports`、错误与限制，并保存检索历史。

这里使用名称、路径和源码内容进行词法排序，TypeScript API 提供语法结构与模块解析。传入 `root` 时查找最近的 `tsconfig.json`/`jsconfig.json`，支持 `baseUrl`、`paths`、限定范围的继承与 NodeNext ESM/CJS 区别。元数据仅在快照覆盖且实时哈希一致时读取；继承暂限仓库内 `tsconfig*.json`/`jsconfig.json`，不遍历 project references 或 bundler 自定义别名。

`ImportReference` 包含 `from`、`specifier`、`line`，以及可选的 `target`、`config`、`names`、`requireCall`、`targetSnapshot`、`reason` 和 `externalDependency: { package, manifest }`。未解析原因仍为 `dynamic-expression`、`config-error`、`not-found-in-snapshot`、`outside-source-snapshot`。新增证据不创建源码目标，也不移除 unresolvedImports：仅标明在当前配置覆盖范围内，哈希验证过的最近包明确声明了普通外部依赖。配置问题记录为 `IMPORT_CONFIG`/`IMPORT_METADATA`，不能成为成功检索证据。

M4 使用 `indexSources(after, root, before.files)`：当前配置下的解析优先，失败后才以基线源码存在性定位删除目标，`targetSnapshot` 标记 `current`/`baseline`；配置和包元数据不会回退到旧版本。历史符号索引使用 `indexSources(before)`，不读取当前配置。`context` 只展示当前目标，不传基线 fallback。`importedBy` 是文件级导入关系，测试关联是候选线索；检索排序质量与更广解析范围仍可按真实案例改进。

### M3 重复检测与增量归因

代码归属：[src/analyze.ts](src/analyze.ts) 中的 `clones` 与 `newClones`。当前和 M2 共用文件。

`clones(state): Promise<Clone[]>` 返回含 `fingerprint`、完整 token 序列 `tokens` 和 `locations` 的匹配；使用完整文件的词法上下文校验两侧，修正检测窗口多带的末尾 token，再核对长度与行数阈值。检测复用固定版本的 jscpd core/tokenizer；规则阈值来自快照配置。

`newClones(before, after, current)` 的前两个参数是 `Snapshot`，第三个是当前 `Clone[]`。它用 KMP 统计当前片段在前后完整 token 流中的出现次数；次数不增长时抑制历史片段，增长时按序列合并发现并返回 `attribution`。`check` 仍分析前后两份源码，不复用历史检测缓存。

报告以 `attributionAlgorithm: "token-occurrences/1"` 标记算法。`newDuplications` 是新增序列组数，`baselineClones`/`currentClones` 是匹配对数，三者不能直接相减。`Finding.attribution` 提供 `kind`（`new-or-expanded`/`additional-copy`）、`baselineOccurrences`、`currentOccurrences` 和涉及文件的 `added`/`modified`/`unchanged` 类型；`locations` 可超过两处。

已覆盖拆分、缩短、扩展、多副本、移动和同文件复制。计数包含重叠出现，不等于函数数或作者归因；删除再复制且净次数不变时与移动无法区分。检测忽略空白与注释，保留标识符与字面量，不处理改名后的语义等价；跨 tokenizer 格式可能漏报，大型仓库性能尚待实测。

若后续需要拆文件，应移动既有检测实现并更新调用与测试，确保 M2/M3 使用同一份快照和配置，不复制另一套扫描逻辑。

### M4 决策检查与行为验证

代码归属：[src/check.ts](src/check.ts) 与 [src/cleanup.ts](src/cleanup.ts)，主要入口为异步 `check(root, run, skipVerification = false)`。

输入是任务基线、当前快照、检索记录、`decision.json` 和基线中的验证配置。输出是发现列表、错误、验证执行结果、文件变化、快照标识与最终状态，落盘到 `report.json`。

当前负责候选是否存在、声明删除是否完成、检索记录是否对应基线、新增重复的处置等级，以及项目验证命令的执行。它组合 M1/M2/M3 的能力，不重新实现文件扫描、语法解析或重复检测。

状态优先级为 `incomplete` → `fail` → `needs-review` → `pass`。解析失败、验证启动失败、超时、任务期间策略变化和检查期间内容变化不能报告通过。缺少验证或显式跳过验证需要评估；已配置且正常执行的验证返回非零退出码则失败。

`cleanupFindings(before, after, oldIndex, current, removals): Finding[]` 复用 M2 索引，检查 `Decision.remove` 声明。目标仍存在、删除文件的残留导入、可确认的命名/默认导出引用及同文件未绑定直接调用产生失败发现；同名局部绑定或当前替代导出不会简单判为残留。

命名空间、非内置 require、动态表达式、转发链、嵌套声明及成员访问等不能确定的引用保留 review；未覆盖目标和归属不明的导入不能静默通过。M4 仅从全局未解析导入提示中排除带 externalDependency 证据的普通导入；不降级可定位的残留引用失败。M2 先尝试当前/基线源码定位，只有均未找到目标时才提供声明证据，复用现有 metadata 读取、哈希检查和缓存，不扫描 node_modules。匹配 paths、baseUrl、同名本地包、工作区、协议依赖或清单覆盖/完整性不足时保持保守；非内置 require 即使有声明也需复核。公共字段为兼容性增补，不修改 Baseline.schema、CLI v1 或归因标识。

没有完整调用图或外部消费者保证，也不自动发现全部死代码。验证命令采用基线配置，以参数数组和 `shell: false` 执行；策略变化或检查中快照变化使结果未完成。例外管理仍为后续任务。p-queue 四份历史补丁的独立回放结果见[评测文档](docs/COMPLEX-AGENT-BENCHMARK.md#后续-m4-清理回放)，历史 agent 数据不改写。

### M5 CLI 与 agent 接入

代码归属：[src/cli.ts](src/cli.ts)、[src/output.ts](src/output.ts) 与 [src/decision.ts](src/decision.ts)。外部契约见 [docs/CLI.md](docs/CLI.md)、[CLI JSON Schema](docs/cli-output.schema.json) 和 [决策形状](docs/decision.schema.json)。

输入是命令行参数，输出是文本或 JSON，以及进程退出码。负责参数校验、调用核心能力和结果呈现；业务规则留在对应核心模块。所有路径都从目标项目的 Git 根目录处理。

命令为 `begin`、`context`、`decide`、`check`，帮助与版本同样支持 `--json`。所有 JSON 输出包含 `schemaVersion: 1`、`toolVersion`、`command`、`outputKind`、`status`、`exitCode`、`errors`、`diagnostics`。退出码为 `0` 通过、`1` 失败、`2` 需要评估、`3` 未完成或错误。

`validateDecision` 为 decide/check 共用的形状校验器，`decide(root, run, options)` 按候选 ID 或 input 文件验证并保存；失败返回 `DECISION_INVALID` 和字段 issues，不覆盖原记录或运行项目验证。本次允许 input 携带 candidate，但仅校验基线 ID 对应的 path/symbol 已在 considered 中，不改变文件内容。`inputOptionIssues` 供 CLI 与核心入口共用，拒绝 input 与 strategy/rationale/disposition/reason/remove 的冲突，避免核心 API 静默忽略参数。

`context` 返回 `candidateId`；`begin --query` 合并起步调用；CLI 的 `decisionGuide` 保留简单 argvTemplate，增补 inputArgvTemplate、inputCandidateRole 和 inputExclusiveFlags，benchmark agent 接入也读取这份指南。复杂模式仍校验所有候选、完整记录及基线检索；原有 input 和手写记录不迁移格式。新 issue code 为 not-considered / conflict，不改变 CLI v1 或基线格式。`check --summary` 仅省略 stdout 的验证日志，持久化完整报告、发现、退出码及验证执行保持原有语义。实质策略仍由 agent 选择。

`resultOutput(command, payload)` 包装业务结果；`errorOutput(command, stage, error)` 包装异常，供 CLI 共用。`outputKind: error` 不保证有业务字段；`result` 也可能 `incomplete`。执行诊断使用 `code`、`message`、`stage` 和可选 `causeCode`；规则发现继续位于 `findings`。M1 代码经 `causeCode` 传出，避免解析消息文本。持久化报告不添加 CLI 公共包装字段。

`verificationGuide(root, run)` 只构造 CLI 接入提示与已填充的 check 参数数组，不重新读取基线或执行验证。begin/context/decide 返回同一指南；默认由 check 执行全部基线验证，省去重复手动整套测试和不必要的帮助查询。`summaryOutput(root, report)` 只呈现已有检查结果，为 failed/error 项保留每项 2,048、总计 4,096 个 JS 字符单位的首尾摘要；错误、发现和原有持久化报告不变。二者归属 M5，不引入验证缓存或改动 M4 编排。

决策回归用四个真实子进程验证：手动全套再 check 执行 8 次，同一工作区仅 check 执行 4 次，结果和覆盖相同；非源码输入变化后相同源码哈希也须全部重跑并发现失败。另覆盖执行失败、启动错误、摘要预算耗尽与完整日志保留。基准提示将接入组的配置命令标为已由 check 执行，保留单项调试和正常审批重试；父评测器仍独立执行四项验收，不能以减少验收换取耗时下降。

MCP 和宿主适配尚未实现，后续按接入需求单独交付并调用现有核心能力。当前没有强制宿主执行约束。

### M6 测试、示例与工程自动化

代码归属：[test/terse.test.mjs](test/terse.test.mjs)、[scripts/demo.mjs](scripts/demo.mjs)、[examples/orders](examples/orders)、[package.json](package.json)、[tsconfig.json](tsconfig.json) 与 [CI 工作流](.github/workflows/ci.yml)。

项目评测由 [scripts/evaluate.mjs](scripts/evaluate.mjs) 执行，[scripts/evaluation-cases.mjs](scripts/evaluation-cases.mjs) 定义任务、变体和预期处置，[examples/evaluation](examples/evaluation) 提供调用入口与独立验收测试。[test/evaluation.test.mjs](test/evaluation.test.mjs) 将评测接入现有 `npm test`；示例和评测共用 [workspace.mjs](scripts/lib/workspace.mjs) 的隔离 Git 工作区与真实 CLI 调用，没有第二套检测器。

实际 agent 对照复用 [scripts/benchmark-agent.mjs](scripts/benchmark-agent.mjs)，`--suite` 选择固定的 [p-map](benchmarks/p-map) 或 [p-queue](benchmarks/p-queue) 输入，默认 p-map 保持兼容。[agent-events.mjs](scripts/lib/agent-events.mjs) 负责真实 JSONL/usage 解析与按任务 ID、重复编号成对统计；[benchmark-project.mjs](scripts/lib/benchmark-project.mjs) 处理等价配置准备、上游计数和包含新增文件的 Git 补丁。准备后的项目必须编译、可分析且无范围外变更，再启动模型。离线协议与发布测试不需要模型凭据；实际实验使用 `npm run benchmark:agent` 单独启动。方法、真实结果和限制见 [p-map](docs/AGENT-BENCHMARK.md) 与 [p-queue](docs/COMPLEX-AGENT-BENCHMARK.md) 文档。

`summarizeEvents(text, terseCli?)` 在提供 CLI 路径时增补 decisions 统计，不改变原有调用结果。它读取工具事件中的 CLI JSON，区分保存、拒绝、帮助和未知结果；只把失败后的后续记录调用计为重试，未知/截断时不报告零重试。[measure-agent-decisions.mjs](scripts/measure-agent-decisions.mjs) 用同一逻辑回算历史日志，先核对每个已发布 eventHash，再写新文件；新旧观测互不覆盖。真实模型仍只在独立评测中调用。

测试验证模块协作和失败路径；示例通过真实 CLI，在两个独立 Git 工作区中比较复制实现与复用实现。两个版本使用相同的行为验收测试。测试数据和真实业务实现分开，不能用移除功能或放松测试换取更少的重复。

已完成 GitHub Actions：面向 main 的 PR、main 推送及手动触发，在 `ubuntu-latest`/`windows-latest` 上使用 Node 24，执行 `npm ci`、`npm test`、`npm pack --dry-run`。工作流只读仓库权限、固定 action 提交，自动取消旧运行；打包预检不发布包。当前存在工作流，不表示已配置仓库强制合并保护。

测试辅助函数以 `rootOf` 规范化 Git 根目录，兼容 Windows TEMP 的短路径；清理前核对隔离目录范围。后续优先扩展真实结构评测与性能样本，继续复用 npm 脚本。

基线案例要包含“合理新增”“相似代码应保持独立”“没有可复用候选”等反例。示例表现只说明具体案例，不直接外推为跨模型的收益比例。

## 模块调用与数据契约

当前调用链如下，箭头表示调用或数据流，并不代表独立进程：

```text
CLI begin   → M1 工作区快照 → baseline.json + decision.json 初始模板
CLI context → M1 读取任务与当前快照 → M2 检索 → context.json
CLI check   → M4 编排
               → M1 基线/当前快照与配置
               → M2 历史符号索引/当前导入解析（可回退基线源码目标）
               → M3 边界校验与前后 token 出现次数归因
               → M4 决策/声明删除/残留引用检查与项目验证
               → 再次采集状态 → report.json + 退出码
M5          → 包装结果或异常 → 文本 / CLI JSON v1
```

共享结构以 [src/types.ts](src/types.ts) 为准，保持一处定义：

- `Source`、`Snapshot`、`Baseline` 描述源码、工作区与任务起点；基线的 `schema` 当前为 `1`。
- `SymbolInfo`、`Location` 描述源码位置和符号内容；行号从 1 开始。
- `Decision` 描述策略、理由、候选处置和计划删除对象。
- `Finding`、`DuplicationAttribution`、`VerificationResult`、`Status` 描述检查证据及验证结果。

`ImportReference` 在 `src/imports.ts` 定义，`Clone` 在 `src/analyze.ts` 定义，`CliOutput`、`Diagnostic`、`ErrorStage` 和退出码映射在 `src/output.ts` 定义，消费者直接复用这些定义。

路径使用相对于 Git 根目录的 `/` 分隔形式，运行数据目录为 `.terse/runs/<id>/`。基线保存源码内容；项目清单的 `metadata` 保存哈希，不应把它描述成完整仓库备份。该目录包含源码，排除在 Git 提交之外。

区分三个版本边界：`Baseline.schema: 1` 是持久化基线格式，`schemaVersion: 1` 是 CLI 输出公共契约，`attributionAlgorithm: "token-occurrences/1"` 是 M3 归因含义。CLI schema 约束公共字段和必需业务字段，未穷举或冻结所有嵌套字段；核心函数返回值仍主要由实现推导，不是稳定库 API。`baseline.json`、`context.json`、`decision.json`、`report.json` 不能当作 CLI 包装对象解析。

增加字段前检查 CLI、示例和测试消费者；CLI 公共字段的删除或含义变化需升级 schemaVersion，其他兼容策略按对应格式说明并更新消费者。内容与算法变更不能只更新版本字符串而不验证旧 run。

修改持久化格式或检测含义时，要考虑 `Baseline.schema`、`ANALYZER` 和旧 run 的处理。当前加载逻辑会拒绝分析器标识不匹配的运行；需要迁移时必须明确实现，不能假设历史缓存自动兼容。配置和分析器依赖变化也必须进入相应的回归验证。

## 本地开发与验证

需要 Node.js 24 或更新版本、Git。首次运行：

```sh
npm ci
npm test
```

`npm test` 会先构建再执行自动化测试，其中已包含完整示例对比与项目评测。需要查看工作区和报告时，可单独运行 `npm run demo` 或 `npm run evaluate`；这不是每次测试之后都必须重复执行的步骤。评测会对成对变体核对相同源码、基线、验收哈希及策略；行为验收和 Terse 检查结果分别记录，不能只以发现数量减少判断成功。

修改期间可先构建，再按模块选择已有测试。例如 M2：

```sh
npm run build
node --test --test-name-pattern="context finds" test/terse.test.mjs
```

提交代码 PR 前运行 `npm test`；出现新变更或失败时，再运行受影响的检查。纯文档改动检查链接、命令与当前源码是否一致，以及 diff 格式，不为此添加与文案一一对应的测试。

当前测试名称可直接用于筛选：

- M1：`M1 rejects`、`M1 CLI`、`baseline captures`、`unreadable source coverage`。
- M2：`context resolves`、`nearest jsconfig`、`NodeNext distinguishes`、`config changes`。
- M3：`splitting or shortening`、`expanded duplicates`、`occurrence attribution`、`new copies of a historical subfragment`。
- M4：`cleanup resolves`、`local residual calls`、`current alias fallback`、`verification failures`。
- M5：`CLI v1`、`CLI distinguishes`、`CLI contract preserves`，以及 [决策回归](test/decision.test.mjs) 的 `M5` 筛选；M6：`example comparison`、`project evaluation`。

缺陷修复应补能复现该缺陷的回归案例；功能变更应覆盖目标行为与重要失败路径。测试断言可观察结果，避免仅复制内部实现步骤。临时 Git 工作区和生成报告使用已隔离的目录，不提交缓存、依赖或构建产物。

新增依赖前先检查现有 Node、TypeScript 和 jscpd 能力。确需依赖时，在 PR 中说明用途和替代方案，同步锁文件与相关分析器标识，避免运行依赖与版本标识不一致。

## 后续交付顺序

首轮完成记录见开头表格。以下是后续方向，不代表全部已经实现或确定排期：

1. **M6 评测扩展。** 受控项目、p-map 和 p-queue 对照已合并。后续扩展项目、模型和样本，检查检索和工作流成本；不能把少量会话外推为跨模型收益比例或一般误报率。
2. **由评测驱动 M2/M3/M4 改进。** 每次选择一个可复现的检索、归因或清理问题，补失败案例后修正，并记录覆盖与性能边界。不要同时重写扫描器或扩大到完整语义分析。
3. **M5 外部适配。** 在具体接入需求明确后做 MCP 或宿主适配，复用 CLI 契约和核心能力，验收成功、待评估、失败与异常路径。
4. **受信任 CI 与例外策略。** 仓库必需检查、策略来源、可审查例外和宿主写入约束需独立设计与授权；现有构建 CI 不构成产品的防篡改验收凭据。

每个切片交付独立 PR；模块边界、接口或验收条件变化时同步更新本文。文档 PR #1 已合并；后续切片的状态以对应 GitHub PR 为准。

## 分支、PR 与完成标准

功能、修复和文档改动都从最新 `main` 创建短期分支，新分支默认用 `codex/` 前缀，例如 `codex/docs-module-progress`。已存在 PR 继续更新原分支；适配 main 时保留已有模块接口并处理冲突，不另开重复 PR。一个 PR 可以包含多次提交。

开发顺序为：明确主模块与验收条件 → 检查已有实现 → 修改及清理 → 运行适当验证 → 更新相关文档 → 提交 PR。PR 采用仓库的 [描述模板](.github/PULL_REQUEST_TEMPLATE.md)，写清具体问题、完成后的行为、模块边界、复用与清理、验证结果和仍有的限制。

跨模块接口变更需在 PR 中列出受影响的消费者；大型接口迁移可先提交兼容的契约与测试，再迁移调用方，并明确旧路径退出条件。避免让主分支依赖尚未合并的实现。

完成标准是验收行为得到验证、被替代代码得到处理、文档与接口一致，以及 PR 中不存在未说明的验证缺口。代码行数下降不是完成条件。PR 创建后供审查，合并作为独立步骤处理；不得仅因代码已提交就标记为已合并。
