# Terse 开发文档

本文用于开发 Terse 本身：说明当前代码归属、模块接口、验证方式，以及按模块交付的顺序。产品使用方式见 [README.md](README.md)，长期目标与设计取舍见 [DESIGN.md](DESIGN.md)。

当前版本为 v0.1.0。本轮 M5/M6 可执行精简以 `main` 的 `bab9516` 为起点，包含 M1–M6 首轮、评测与接入优化 #8–#20、M5 Skill 初始化 #22、M6 Skill 会话 #23、p-queue Skill 评测 #24、M5 删除声明约束 #25、M6 删除声明复测 #26 和 M4 私有清理 #27；#27 在 Windows/Linux Node 24 CI 各通过 291 项测试（含子用例）及打包预检。本轮不包含 #21 分支，后续数量以各提交 CI 为准。模块首轮完成不表示长期设计中的全部能力已实现。

| 模块 | 已合并的首轮交付 | PR |
| --- | --- | --- |
| M1 | 持久化基线结构、整体哈希校验与错误诊断 | [#3](https://github.com/jinyangtang33-sys/Terse/pull/3) |
| M2 | 导入与路径别名解析 | [#4](https://github.com/jinyangtang33-sys/Terse/pull/4) |
| M3 | 重复片段边界校验与 token 出现次数归因 | [#5](https://github.com/jinyangtang33-sys/Terse/pull/5) |
| M4 | 声明删除与残留引用检查，适配 M2 | [#6](https://github.com/jinyangtang33-sys/Terse/pull/6) |
| M5 | CLI 输出契约 v1 与结构化错误 | [#7](https://github.com/jinyangtang33-sys/Terse/pull/7) |
| M6 | Windows/Linux 构建、测试与打包预检 | [#2](https://github.com/jinyangtang33-sys/Terse/pull/2) |

已合并的 [项目评测](docs/EVALUATION.md) 有 6 个场景、11 个实现变体，包含改写式重复反例。[p-queue 实际 agent 评测](docs/COMPLEX-AGENT-BENCHMARK.md) 及复测已合并。M6 用订单项目六类任务运行实际 agent 对照，以行为、复用、清理和职责边界为主要标准，耗时作辅助；方法与局限见 [功能效果评测](docs/FUNCTIONAL-AGENT-BENCHMARK.md)。本次 M5 交付针对重复执行整套验证及失败 summary 缺少日志的问题；完整检查和功能效果仍是主要标准，不以总耗时下降作为验收条件。

历史与本轮各完成 12 次真实会话，两组均各 6/6 行为及非盲补丁审查达标；本轮五个已有候选命中，独立新增精确重复与相似实现均为 0，清理完成，仍未观察到接入相对对照组的功能改善。改写式反例在当前离线回归产生 POSSIBLE_DUPLICATION，本轮真实会话未产生该反例。新结果单独发布到 optimized-observed，两个观测目录各自绑定冻结输入与全部发布文件哈希；历史 observed 的 26 个文件、旧归档和原哈希不变。

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

代码归属：[src/analyze.ts](src/analyze.ts) 中的 `clones` 与 `newClones`，以及 [src/similarity.ts](src/similarity.ts) 的实现锚点复核。原有 token 检测和 M2 共用文件；新增模块承载不同证据及增量配对，不复制 token 扫描器。

`clones(state): Promise<Clone[]>` 返回含 `fingerprint`、完整 token 序列 `tokens` 和 `locations` 的匹配；使用完整文件的词法上下文校验两侧，修正检测窗口多带的末尾 token，再核对长度与行数阈值。检测复用固定版本的 jscpd core/tokenizer；规则阈值来自快照配置。

`newClones(before, after, current)` 的前两个参数是 `Snapshot`，第三个是当前 `Clone[]`。它用 KMP 统计当前片段在前后完整 token 流中的出现次数；次数不增长时抑制历史片段，增长时按序列合并发现并返回 `attribution`。`check` 仍分析前后两份源码，不复用历史检测缓存。

报告以 `attributionAlgorithm: "token-occurrences/1"` 标记算法。`newDuplications` 是新增序列组数，`baselineClones`/`currentClones` 是匹配对数，三者不能直接相减。`Finding.attribution` 提供 `kind`（`new-or-expanded`/`additional-copy`）、`baselineOccurrences`、`currentOccurrences` 和涉及文件的 `added`/`modified`/`unchanged` 类型；`locations` 可超过两处。

已覆盖拆分、缩短、扩展、多副本、移动和同文件复制。计数包含重叠出现，不等于函数数或作者归因；删除再复制且净次数不变时与移动无法区分。检测忽略空白与注释，保留标识符与字面量，不处理改名后的语义等价；跨 tokenizer 格式可能漏报，大型仓库性能尚待实测。

若后续需要拆文件，应移动既有检测实现并更新调用与测试，确保 M2/M3 使用同一份快照和配置，不复制另一套扫描逻辑。

本轮以 main 4ad831a 为起点增加 POSSIBLE_DUPLICATION。indexSources(state, root?, fallbackFiles?, collectImplementations=false) 复用同一次 AST 解析，可选返回 implementations；只有 check 的历史与当前索引开启采集，默认 context 调用不增加此工作。implementation(body, ast, location) 提取保守的字符串、数据成员、操作证据；similarImplementations(before, after, exactFindings) 做一对一历史匹配并抑制同对精确发现。无新依赖或模型服务。

Finding.similarity 与顶层 similarityAlgorithm: implementation-anchors/1、possibleDuplications 属兼容性增加；旧基线重新由保存源码分析，Baseline.schema、ANALYZER、CLI v1 与 token-occurrences/1 不变。新规则始终 review，不借用 duplicatePolicy 的 fail。已知改写式重复由 pass 变为 needs-review，委托已有实现后通过；详细条件、证据截断、历史边界和负例见 [实现复核](docs/SIMILARITY.md)。一般语义等价或职责判断仍未实现。

### M4 决策检查与行为验证

代码归属：[src/check.ts](src/check.ts) 与 [src/cleanup.ts](src/cleanup.ts)，主要入口为异步 `check(root, run, skipVerification = false)`。

输入是任务基线、当前快照、检索记录、`decision.json` 和基线中的验证配置。输出是发现列表、错误、验证执行结果、文件变化、快照标识与最终状态，落盘到 `report.json`。

当前负责候选是否存在、声明删除是否完成、检索记录是否对应基线、新增重复的处置等级，以及项目验证命令的执行。它组合 M1/M2/M3 的能力，不重新实现文件扫描、语法解析或重复检测。

状态优先级为 `incomplete` → `fail` → `needs-review` → `pass`。解析失败、验证启动失败、超时、任务期间策略变化和检查期间内容变化不能报告通过。缺少验证或显式跳过验证需要评估；已配置且正常执行的验证返回非零退出码则失败。

`cleanupFindings(before, after, oldIndex, current, removals): Finding[]` 复用 M2 索引，检查 `Decision.remove` 声明。目标仍存在、删除文件的残留导入、可确认的命名/默认导出引用及同文件未绑定直接调用产生失败发现；同名局部绑定或当前替代导出不会简单判为残留。

本轮在同一清理入口复用已有 bindings AST，匹配唯一同文件命名顶层类的 `#` 私有方法。当前仍声明该私有名则 fail；按词法环境遍历成员，残留调用、读取或品牌检查 fail；嵌套类的成员遮蔽与 extends 外层环境分别处理。无残留时可确认该目标清理，不再受无关文件导入影响；直接 eval、装饰器、ambient/歧义/移动类保留 review。其他删除目标的 M2 检查、M5 漏填约束及全部验证继续运行。公共接口、schema 与算法标识均不变，无新依赖。边界与当前回放见 [私有方法清理](docs/PRIVATE-CLEANUP.md)，历史数据和哈希不改写。

命名空间、非内置 require、动态表达式、转发链、嵌套声明及成员访问等不能确定的引用保留 review；未覆盖目标和归属不明的导入不能静默通过。M4 仅从全局未解析导入提示中排除带 externalDependency 证据的普通导入；不降级可定位的残留引用失败。M2 先尝试当前/基线源码定位，只有均未找到目标时才提供声明证据，复用现有 metadata 读取、哈希检查和缓存，不扫描 node_modules。匹配 paths、baseUrl、同名本地包、工作区、协议依赖或清单覆盖/完整性不足时保持保守；非内置 require 即使有声明也需复核。公共字段为兼容性增补，不修改 Baseline.schema、CLI v1 或归因标识。

没有完整调用图或外部消费者保证，也不自动发现全部死代码。验证命令采用基线配置，以参数数组和 `shell: false` 执行；策略变化或检查中快照变化使结果未完成。例外管理仍为后续任务。p-queue 四份历史补丁的独立回放结果见[评测文档](docs/COMPLEX-AGENT-BENCHMARK.md#后续-m4-清理回放)，历史 agent 数据不改写。

### M5 CLI 与 agent 接入

本轮增加 [可执行精简](docs/SIMPLIFICATION.md)：`simplify(root, run, candidate, into, apply=false)` 在 src/simplify.ts 定位两个基线候选并重新核对当前源码。只对限定的同文件精确重复普通函数执行 body 委托，保留原公开契约；默认返回只读计划，apply 实际替换源文件并复用 M4 完整 check。只有编辑保留且完整验证通过才标记 simplificationVerified。plan.metrics 记录实际源码字节、非空行、非 trivia token 与相同 body 数量变化，不将 pass 或零新增重复当作精简。未支持语法与语义条件拒绝执行；预览、失败和未完成均不声称成功。CLI 增加 simplify 命令与 into/apply 参数，schemaVersion、基线与归因标识保持兼容；原 check 含义不变，历史数据不改写。Skill 引导 agent 交付真实精简补丁及必要新增的证据；demo:simplify 在真实 CLI 下先收敛两个导出体，再对比新需求的原位修改和复制变体，明确为无模型调用的受控验收。

本轮 [删除声明约束](docs/REMOVAL-DECLARATIONS.md) 在 check 核对观察到的消失目标，漏填返回 REMOVAL_DECLARATION_MISSING / fail 及 undeclaredRemovals。indexSources 在原 AST 遍历中保留声明字符范围，cleanup.undeclaredRemovals 以基线路径/名称对比并折叠退役父声明；check 将推导目标交给原 M4 检查，配置验证照常执行。decisionGuide.removalGuide 和 Skill 说明完整输入与同一 run 修正；原地重构允许空声明，不强制按 strategy 猜删除。声明结构、基线、CLI v1 及归因算法兼容。旧评测发布和归档未修改；活跃手工评测的迁移变体补上应有声明，M3/M4 回归也按实际迁移声明目标。

代码归属：[src/cli.ts](src/cli.ts)、[src/output.ts](src/output.ts) 与 [src/decision.ts](src/decision.ts)。外部契约见 [docs/CLI.md](docs/CLI.md)、[CLI JSON Schema](docs/cli-output.schema.json) 和 [决策形状](docs/decision.schema.json)。

输入是命令行参数，输出是文本或 JSON，以及进程退出码。负责参数校验、调用核心能力和结果呈现；业务规则留在对应核心模块。所有路径都从目标项目的 Git 根目录处理。

命令为 `init`、`begin`、`context`、`decide`、`simplify`、`check`，帮助与版本同样支持 `--json`。所有 JSON 输出包含 `schemaVersion: 1`、`toolVersion`、`command`、`outputKind`、`status`、`exitCode`、`errors`、`diagnostics`。退出码为 `0` 通过、`1` 失败、`2` 需要评估、`3` 未完成或错误。

`validateDecision` 为 decide/check 共用的形状校验器，`decide(root, run, options)` 按候选 ID 或 input 文件验证并保存；失败返回 `DECISION_INVALID` 和字段 issues，不覆盖原记录或运行项目验证。本次允许 input 携带 candidate，但仅校验基线 ID 对应的 path/symbol 已在 considered 中，不改变文件内容。`inputOptionIssues` 供 CLI 与核心入口共用，拒绝 input 与 strategy/rationale/disposition/reason/remove 的冲突，避免核心 API 静默忽略参数。

`context` 返回 `candidateId`；`begin --query` 合并起步调用；CLI 的 `decisionGuide` 保留简单 argvTemplate，增补 inputArgvTemplate、inputCandidateRole 和 inputExclusiveFlags，benchmark agent 接入也读取这份指南。复杂模式仍校验所有候选、完整记录及基线检索；原有 input 和手写记录不迁移格式。新 issue code 为 not-considered / conflict，不改变 CLI v1 或基线格式。`check --summary` 仅省略 stdout 的验证日志，持久化完整报告、发现、退出码及验证执行保持原有语义。实质策略仍由 agent 选择。

`resultOutput(command, payload)` 包装业务结果；`errorOutput(command, stage, error)` 包装异常，供 CLI 共用。`outputKind: error` 不保证有业务字段；`result` 也可能 `incomplete`。执行诊断使用 `code`、`message`、`stage` 和可选 `causeCode`；规则发现继续位于 `findings`。M1 代码经 `causeCode` 传出，避免解析消息文本。持久化报告不添加 CLI 公共包装字段。

`verificationGuide(root, run)` 只构造 CLI 接入提示与已填充的 check 参数数组，不重新读取基线或执行验证。begin/context/decide 返回同一指南；默认由 check 执行全部基线验证，省去重复手动整套测试和不必要的帮助查询。`summaryOutput(root, report)` 只呈现已有检查结果，为 failed/error 项保留每项 2,048、总计 4,096 个 JS 字符单位的首尾摘要；错误、发现和原有持久化报告不变。二者归属 M5，不引入验证缓存或改动 M4 编排。

决策回归用四个真实子进程验证：手动全套再 check 执行 8 次，同一工作区仅 check 执行 4 次，结果和覆盖相同；非源码输入变化后相同源码哈希也须全部重跑并发现失败。另覆盖执行失败、启动错误、摘要预算耗尽与完整日志保留。通过指南执行的相似度回归保留完整 POSSIBLE_DUPLICATION 证据及行为失败摘要，清理回归保留 REMOVAL_REMAINS / REMOVAL_REFERENCE_UNRESOLVED，并在 fail/review 下每次执行全部验证。p-queue 与订单评测提示共用这份指南；父评测器仍独立执行完整验收，不能以减少验收换取耗时下降。

MCP 和宿主 hook 尚未实现，后续按接入需求单独交付并调用现有核心能力。当前没有强制宿主执行约束。

M5 新增项目接入入口 `init(root, verification?)` / `terse init [--verify <command JSON>]`，实现集中在 [init.ts](src/init.ts)，复用 project 的配置校验，不改变基线格式和分析算法。安装的 [Skill](skills/terse/SKILL.md) 经 AGENTS.md 或根 override 引导普通 JS/TS 开发任务；项目启动器只转发到原 CLI。既有配置和指令保留，冲突先拒绝，缺失验证明确需要完善；本地 CLI 绑定置于被忽略的 .terse/agent.json。说明见 [Agent 接入](docs/AGENT-INTEGRATION.md)。这属于指令层接入，没有宿主 hook、MCP 或强制编辑门槛。

`npm run demo:agent` 通过安装后的启动器，完成正常订单需求的检索/决策、复制草稿的完整 check、同一基线上的复用修正及复验。复用既有工作区、CLI 调用和订单任务构造；初次与最终报告分别保留，明确是无模型调用的确定性接入示例。[init.test.mjs](test/init.test.mjs) 覆盖初始化、指令优先级、配置保留、命令及路径失败、状态传递和完整集成；Skill 模板随包发布。历史评测输入及发布文件不回填。

### M6 测试、示例与工程自动化

本轮 [p-queue 删除声明复测](docs/PQUEUE-REMOVAL-SKILL-BENCHMARK.md) 在已合并 #25 的 main 上保持普通任务与四组验收，另测主动声明、真实遗漏与同一 run 修正。skill-evidence 复用既有阶段和检查区间判定，增加规则/缺失目标观察、会话结束时 finalRunStates 与 removalWorkflow；严格 workflow 不放宽。新发布单独保存，旧数据与产品/Skill 不修改。没有自然遗漏时不填造修正样本，元数据缺失单独记录。

六次新真实会话现已完成：行为/非盲复用及实际清理审查 6/6，主动声明 4/4，遗漏与自主补填机会均为 0。声明检查完成 6/6，其中两次保留成员引用复核，因此严格工作流仍为 4/6。新发布与冻结归档位于 benchmarks/skill/p-queue-removal-observed 和 fixtures/6585f42…，旧数据和哈希不变。发布回归共用 pqueue-skill-publication 测试函数；补强同命令多响应反馈的保留，六份观察重算结论未改变，不将保留复核标作 pass。

Skill 运行器增加 --suite p-queue / --source。适配器 [pqueue-skill.mjs](scripts/lib/pqueue-skill.mjs) 复用原三类业务任务与四组验收，普通提示不携带工具指令。原 benchmark-agent 与新套件共用 [open-source-project.mjs](scripts/lib/open-source-project.mjs) 的隔离复制/等价配置准备及 verifyCommand 的执行、计数和日志哈希；每个会话有独立依赖副本。新的 editable、initialScopeHash / finalScopeHash 将阶段判定扩展到 source/ 和 README，旧观察缺省仍兼容，不回填历史。上游源文本、锁和许可随新归档保存；规则见 [p-queue Skill 评测](docs/PQUEUE-SKILL-BENCHMARK.md)，离线边界回归见 [pqueue-skill.test.mjs](test/pqueue-skill.test.mjs)。

p-queue 六次真实会话已完成：行为、人工复用与清理审查各 6/6，完整工作流 4/6。两次重构漏填旧私有方法的删除声明，保留失败计分；父分析的成员引用不确定提示也原样保存，不视为实际残留。四组验证由父进程独立复验，决策格式重试为 0，但保留环境重试及重构中的类型修正。[pqueue-skill-publication.test.mjs](test/pqueue-skill-publication.test.mjs) 校验新发布的 21 个文件、冻结输入及上游锁，重算工作流并静态回放六份补丁；不调用模型或冒充再次运行上游行为测试。旧各轮发布与产品 src/、Skill 模板均未修改。

审查后，带范围快照的最终 check 还要求同一命令开始、完成和区间内观察的 scopeHash 稳定，拒绝同命令 check 后改 README 的误计。缺失开始证据不能算完整检查；新一条独立完整复验可以恢复。本轮六份原始观测重算结论不变，冻结的预登记代码与发布字节均保留。

Skill 冷启动评测入口为 [benchmark-skill.mjs](scripts/benchmark-skill.mjs)，复用现有订单任务、prepareEvaluation、runAgent、保护文件校验和结构分析。任务 [skill-cases.mjs](scripts/skill-cases.mjs) 只提供普通业务需求；宿主仅 init，不提供基线、候选或流程提醒。runAgent 的可选 onEvent 回调在父进程观察事件，不修改模型输入输出，既有套件默认执行方式不变。新的 [skill-evidence.mjs](scripts/lib/skill-evidence.mjs) 将阶段证据与实际磁盘快照绑定，观察不足、过期检查、补写决策及重复基线不能算完整成功。[独立发布器](scripts/export-skill-benchmark.mjs) 校验实际输入、补丁和观察哈希并另存冻结归档，保留全部会话；离线回归见 [skill-agent.test.mjs](test/skill-agent.test.mjs)，规则与结果见 [Skill 评测](docs/SKILL-AGENT-BENCHMARK.md)。

本轮在预登记提交 85d8679 完成六个独立真实会话，各自只有普通业务提示；六次均在修改前读取/检索/决策，并在同一基线上完整 check 通过，父运行时验收和人工复用/清理审查亦达标。原始记录留本地，新发布及冻结输入位于 benchmarks/skill，旧四轮数据不变。[skill-publication.test.mjs](test/skill-publication.test.mjs) 校验所有发布字节和冻结输入、重算工作流并离线重放六份实际补丁。prepareEvaluation / createWorkspace 的可选 fixtureRoot 允许读取冻结夹具，默认路径及旧套件不变。小样本无 control，不外推一般触发率或相对收益。

代码归属：[test/terse.test.mjs](test/terse.test.mjs)、[scripts/demo.mjs](scripts/demo.mjs)、[examples/orders](examples/orders)、[package.json](package.json)、[tsconfig.json](tsconfig.json) 与 [CI 工作流](.github/workflows/ci.yml)。

项目评测由 [scripts/evaluate.mjs](scripts/evaluate.mjs) 执行，[scripts/evaluation-cases.mjs](scripts/evaluation-cases.mjs) 定义任务、变体和预期处置，[examples/evaluation](examples/evaluation) 提供调用入口与独立验收测试。[test/evaluation.test.mjs](test/evaluation.test.mjs) 将评测接入现有 `npm test`；示例和评测共用 [workspace.mjs](scripts/lib/workspace.mjs) 的隔离 Git 工作区与真实 CLI 调用，没有第二套检测器。

功能效果对照入口为 [benchmark-reuse.mjs](scripts/benchmark-reuse.mjs)，与人工变体共用 prepareEvaluation；与外部开源项目对照共用 runAgent。每次行为验收都由父进程独立重跑。validateFunctionalReviews 要求每份功能判断绑定实际补丁和具体理由，不允许将行为失败或协议不完整算作成功；发布器进一步核对补丁字节，省略原始事件及最终自由文本。该夹具不使用第三方依赖锁。产品分析器、基线格式、CLI 契约及 token 算法均未改变；真实会话启动仍需具备对应的数据外发授权。

protectedFileEvidence(root, expectedHashes, acceptanceFiles) 用运行前记录构造验收身份，实际文件只用于篡改核对；验收文件缺失、改名或被目录替换时返回 tampered，保留协议无效的样本及原验收哈希，避免中止后续会话。历史输入归档与 observed 发布文件逐字节校验，当前 oracle 的演进不改变旧观测。

M6 评测完整性修复（以 main `84e827b` 为起点）：`captureChangeBaseline(root)` 在 agent 启动及接手 WIP 安装之前捕获实际文件的 Git tree，包含起点原有的暂存、未暂存和未跟踪内容，不依赖 HEAD。`collectChanges(root, editable, changeBaseline)` 强制传入这个固定 tree，以私有临时 index 构造终态，再比较两个 tree；不读当前 index 作为基准，也不对真实 index 执行 intent-to-add。暂存、删除、改名、二进制和新增越界文件都进入 changed/patch，outsideScope 单独判定；Git 路径采用 NUL 协议和 literal pathspec，保留 Unicode 与特殊字符。受 Git 属性控制的文本规范化仍遵循该项目的 Git 语义。`evidence.changeBaseline` 保存初始 tree 标识。

独立 Node 行为验收统一复用 `verifyCommand`。宿主在准备阶段用 [test-evidence.mjs](scripts/lib/test-evidence.mjs) 的 `freezeTestCases(project, args)` 从受保护夹具登记文件、名称及调用位置，不导入候选源码；支持显式文件列表和顶层字面量 node:test 调用。动态生成或嵌套套件需要另行定义清单契约，不退回数量判定。宿主 [test-reporter.mjs](scripts/lib/test-reporter.mjs) 输出结构化事件；候选 stdout 仅作为事件数据，不能凭打印通过文本取得信用。只有预登记用例全部恰好执行并通过、每个文件及总汇正常完成、无失败/跳过/TODO/取消且进程成功，验收才 passed；缺失或截断输出也不通过。结果保留 testEvidence 与原始日志哈希，构建/类型命令及 AVA 上游检查保留原规则。这是 Node 行为验收的执行证据，不是对恶意代码的安全沙箱，也不代替补丁职责审查或产品自定义验证的契约。

修复应用于后续 benchmark-agent、benchmark-reuse、benchmark-skill（含 p-queue）运行；新计划用 evaluationIntegrity 标记 frozen-git-tree/1 与 named-node-tests/1。历史评测、冻结夹具、发布哈希和旧计分一律不回填，不因本轮离线反例而声称历史会话使用了这些手法。本轮回归 [benchmark-integrity.test.mjs](test/benchmark-integrity.test.mjs) 用真实 Git/Node 验证收集补丁可重放、原暂存区不变，以及提前退出的三文件假通过、部分执行、跳过、TODO、取消、超时和伪造日志；不启动新的模型会话。

analyzeEvaluation(project, before, removals) 复用 M1 快照及 M3/M4 分析，对两组同样开启实现证据采集，返回 duplications/newDuplications、similarities/possibleDuplications、similarityAlgorithm 和 cleanup；精确发现抑制同对相似提示，与产品 check 一致。捕获包括配置读取在内的源码评分异常，失败记录 duplicationError，两类重复计数和证据保持 null；有效快照才参与 workflow 核验，避免配置损坏使整轮对照在保存无效结果前中断。发布器验证新测量的计数与证据匹配；老报告可不含相似度字段，不回填历史测量。

发现与修正套件复用 benchmark-reuse 的 --suite challenge，任务归属 [challenge-cases.mjs](scripts/challenge-cases.mjs)，新流式验收位于 examples/challenge；prepareEvaluation 的可选 acceptance 路径沿用相同三份验证编排。接手 WIP 在 begin 和真实基线检索之后安装，不回填检索，不把已知新问题作为历史基线。initial.patch / initial-analysis.json 分别绑定哈希，两组 startingHash 必须相同。agent-events 的 checks 保留工具返回快照与发现，correctionEvidence 仅在先警告、后完整 pass、父分析干净且源码改变时计为观察到修正；无机会、输出缺失和未修正不计为成功。新 [发现与修正文档](docs/CORRECTION-AGENT-BENCHMARK.md) 分开报告自然开发与接手修复，八次实际会话和冻结证据另存 challenge-observed，前两轮数据不变。

复杂自然套件复用 --suite natural-complex，任务位于 [natural-cases.mjs](scripts/natural-cases.mjs)，prepareEvaluation 的 sourceFixture 复制正常多模块起点，禁止 seed 和非空初始 patch。每个运行复用 runAgent 两次，首稿留档后再复核；summarizePhases 只给派生事件加阶段前缀，保留两份原始 eventHash，并防止缺失首稿完成事件被复核掩盖。draft.patch / draft-analysis.json 绑定原字节，validateFunctionalReviews 分别校验首稿与终稿审查，补充 duplicateFree / cleanupComplete 计量。任一阶段篡改保护文件都不能通过协议，首稿不得提前 check，Terse 首次复核须匹配首稿快照；固定验收外观察单独保留而不改主分数。12 个运行及 24 次实际调用另存 natural-observed，前三轮及其归档不变。详见 [自然开发评测](docs/NATURAL-AGENT-BENCHMARK.md)。

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

1. **M6 功能效果评测。** 主要验收为行为正确、实际复用或修改、旧路径清理，以及合理新增和不确定引用的处置；token 克隆计数与耗时均为辅助。改写式重复可在 token 零发现时仍冗余，须结合补丁审查；小样本不外推一般误报率、漏报率或跨模型收益。
2. **由评测驱动 M2/M3/M4 改进。** 每次选择一个可复现的检索、归因或清理问题，补失败案例后修正，并记录覆盖与性能边界。不要同时重写扫描器或扩大到完整语义分析。
3. **M5 外部适配。** 项目 Skill 与 init 提供本轮首个安装入口；后续按具体需求增加 MCP 或宿主 hook，复用 CLI 契约和核心能力，验证实际自动触发及成功、待评估、失败与异常路径。
4. **受信任 CI 与例外策略。** 仓库必需检查、策略来源、可审查例外和宿主写入约束需独立设计与授权；现有构建 CI 不构成产品的防篡改验收凭据。

每个切片交付独立 PR；模块边界、接口或验收条件变化时同步更新本文。文档 PR #1 已合并；后续切片的状态以对应 GitHub PR 为准。

## 分支、PR 与完成标准

功能、修复和文档改动都从最新 `main` 创建短期分支，新分支默认用 `codex/` 前缀，例如 `codex/docs-module-progress`。已存在 PR 继续更新原分支；适配 main 时保留已有模块接口并处理冲突，不另开重复 PR。一个 PR 可以包含多次提交。

开发顺序为：明确主模块与验收条件 → 检查已有实现 → 修改及清理 → 运行适当验证 → 更新相关文档 → 提交 PR。PR 采用仓库的 [描述模板](.github/PULL_REQUEST_TEMPLATE.md)，写清具体问题、完成后的行为、模块边界、复用与清理、验证结果和仍有的限制。

跨模块接口变更需在 PR 中列出受影响的消费者；大型接口迁移可先提交兼容的契约与测试，再迁移调用方，并明确旧路径退出条件。避免让主分支依赖尚未合并的实现。

完成标准是验收行为得到验证、被替代代码得到处理、文档与接口一致，以及 PR 中不存在未说明的验证缺口。代码行数下降不是完成条件。PR 创建后供审查，合并作为独立步骤处理；不得仅因代码已提交就标记为已合并。
