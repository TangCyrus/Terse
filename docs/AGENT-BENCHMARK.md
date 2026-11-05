# 开源项目 agent 对照评测

这套 M6 评测让实际 Codex agent 修改同一开源项目，比较正常工作流和接入 Terse 的工作流。与 [受控实现评测](EVALUATION.md) 区分：实现由模型现场生成，评测器不预写复制版或复用版，也不要求结果必须有利于 Terse。

本次 p-map 任务中，两组各 2/2 通过独立验收，新增重复均为 0；没有观察到 Terse 额外减少重复。接入组的平均 agent 墙钟时间更长。原始数值与可审查补丁已提交，不能以手工复制对照的结果替代这一实际观察。

后续 M5 命令式接入的独立复测见下文，原始手写记录组的数据保留不变。

多文件 TypeScript 的修改、删除、重构任务已扩展到 [p-queue 对照评测](COMPLEX-AGENT-BENCHMARK.md)。它继续使用本脚本和优化后的命令式接入，单独保存新项目的任务与观测，不替换本文历史数据。

## 实际观测

[比较结果](../benchmarks/p-map/observed/comparison.json) 来自 2026-11-05 的四次有效 CLI 会话，按执行顺序：

| 配对 | 工作流 | 本任务验收 | 上游运行时 | 类型 | 新增重复组 | agent 秒 | CLI 输入 token（含缓存） | CLI 输出 token |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 无 Terse | 5/5 | 49/49 | 通过 | 0 | 64.478 | 181673 | 1610 |
| 1 | 有 Terse | 5/5 | 49/49 | 通过 | 0 | 178.509 | 606370 | 4197 |
| 2 | 有 Terse | 5/5 | 49/49 | 通过 | 0 | 134.855 | 375020 | 3215 |
| 2 | 无 Terse | 5/5 | 49/49 | 通过 | 0 | 76.281 | 181153 | 2010 |

本机观察的均值为无 Terse 70.4 秒、有 Terse 156.7 秒，差约 86.3 秒。原始毫秒数、缓存 token、命令数、事后验收耗时和每个配对的差值见 JSON。token 是 CLI 返回的用量字段，不是唯一上下文长度，也没有转换成费用或“节省率”。

四份补丁均由 agent 生成，分别保存在结果目录的 `pair-*.patch`；人工检查其新增 `pMapSettled` 都调用既有 `pMap`，没有另建调度循环。两组的行为结果与 token 重复证据一致，表明这个任务中基础 agent 已能找到复用途径。Terse 组额外执行了检索、决策和检查；第一组还发生决策字段格式修正。这些是观察到的工作流成本，不能由此断言 Terse 在所有项目都无效。后续应测试更难定位职责的任务，并改进决策契约的发现体验。

测量边界：同机运行但未隔离全部系统背景负载，本地离线工程测试与第一轮 control 的前约 35 秒有重叠；顺序交换只能提供补充观察，不能消除所有系统或模型变化。`comparable` 字段检查基线和执行协议一致，不表示已控制硬件负载。因此墙钟时间是本机描述性结果，差值不能全部归因于 Terse。

有效实验之前有一个被中止的环境试跑：忽略本机配置时，子 agent 的执行策略拒绝了源码读取和验收命令，未修改源码。该试跑及连接预检的本地日志保留，不混入四次有效任务；之后通过保留本机 Windows/代理配置并使用 `--approve-for-me`，先验证了实际读写，再完整重启配对。有效四次运行均未超时、未修改保护文件、未跨编辑范围，且有真实命令事件；两次 Terse 运行均保留最终工作流证据。

上游派生补丁随附 [MIT 许可](../benchmarks/p-map/UPSTREAM-LICENSE)。依赖锁快照为 [dependency-lock.json.gz](../benchmarks/p-map/observed/dependency-lock.json.gz)，用于复现该次安装，而非升级项目依赖。

## M5 命令式接入复测

M5 新增 `decide`、候选 ID 和 `check --summary` 后，用同一任务、模型、依赖锁、时限与验收重新执行四个独立会话。结果单独保存在 [commands-observed/comparison.json](../benchmarks/p-map/commands-observed/comparison.json)，`workflow` 标记为 `commands`。此次没有并行运行工程测试，仍未对全部系统背景负载作严格隔离。

| 配对 | 工作流 | 验收 | 新增重复组 | agent 秒 | 命令事件数 |
| --- | --- | --- | --- | --- | --- |
| 1 | 无 Terse | 5/5 + 49/49 + 类型通过 | 0 | 106.194 | 12 |
| 1 | 命令式 Terse | 5/5 + 49/49 + 类型通过 | 0 | 118.037 | 13 |
| 2 | 命令式 Terse | 5/5 + 49/49 + 类型通过 | 0 | 87.760 | 9 |
| 2 | 无 Terse | 5/5 + 49/49 + 类型通过 | 0 | 68.421 | 8 |

两次 Terse 会话均一次成功调用 `decide`（本地 JSONL 的 command_execution item_5、item_4，退出码均为 0），没有重现原先的手写字段修正。四份补丁均复用既有 pMap，独立验收和协议检查均通过。

本轮均值为无 Terse 87.3 秒、命令式 Terse 102.9 秒。历史手写接入为 156.7 秒；此次 Terse 的命令事件均值为 11，历史为 16.5。这是有用的接入观察，但控制组均值也从 70.4 秒变为 87.3 秒，两轮不是同时开展的严格版本对照，不能把 53.8 秒差值当作已证实的普遍提速。命令事件数包含源码阅读、实现与验收，并非纯 Terse 调用数。

该复测由父评测器预建 run，因此只验证命令式决策和精简 check 的接入，不计入 `begin --query` 合并起步调用的收益；三步起步流程由独立 CLI 回归覆盖。CLI 的 pass 仍不是语义审批，精简返回仍执行完整验证；新旧报告的 token 字段均来自实际 CLI，不估算费用。

复测是在本 PR 的工作区实现构建后执行，报告中的 `terseRevision` 是当时已提交的起点 `85c45c8`，不代表该提交已经包含未提交的 M5 功能。复现命令式运行应使用包含本次实现的 PR 提交。原始事件、提示和验证日志保留在本地 `.terse/agent-benchmark-e63jB7`；发布目录包含补丁、哈希绑定结果和同一依赖锁快照。后续模型或网络状态变化可能产生不同结果。

## 固定实验

项目选用 [sindresorhus/p-map v7.0.3](https://github.com/sindresorhus/p-map/tree/v7.0.3)，固定提交 `2ba3a002acac080c60c47ca1dfa2fad3e17f5b7c`，MIT 许可。它包含真实的并发映射、异步迭代、取消处理、类型声明与上游测试。项目的后续版本不属于本实验输入；新增 API 任务只针对此固定版本。

[project.json](../benchmarks/p-map/project.json) 记录模型请求名、推理等级、次数、时限和编辑范围；[task.md](../benchmarks/p-map/task.md) 是两组共享的需求。任务为新增 `pMapSettled`，把 mapper 成功或失败转成有序记录，同时保留并发、skip、abort、原 API 与类型约束。拒绝的输入 promise 不在这次新增功能验收范围；迭代器错误仍应拒绝。

默认执行两次配对、四次独立 agent 会话：第一对 control→terse，第二对 terse→control。每次均从相同上游文件与同一份已安装依赖重新复制，使用同一请求模型 `gpt-6.1-sol`、medium 推理、600 秒时限及 workspace-write 沙箱。历史会话不恢复，禁止另开 agent 或搜索上游新实现。

- control：使用项目源码和给定验收，正常实施需求，提示不调用 Terse。
- terse：额外提供现有 run、`context` 命令、决策记录位置和 `check` 命令，要求在修改前检索、如实记录策略并检查结果。检索、记录和修复共用同一时限。

提示的这段工作流差异就是干预，不能将结果解释为“只有检测算法”的作用。工作区隔离和提示约束不构成对任意恶意 agent 的安全隔离证明。

## 独立验收和指标

执行前先确认上游 49 项 AVA 运行时测试通过，且新功能验收失败。每次 agent 结束后，由父评测器独立执行：

1. [5 项新增运行时验收](../benchmarks/p-map/acceptance.mjs)：顺序、错误身份、原索引、同步/异步 mapper 失败、并发、异步输入、空输入、skip、参数/迭代错误及 abort。
2. 固定上游的 AVA 运行时测试，保护原有行为。
3. [类型验收](../benchmarks/p-map/acceptance-types.mts)，用该项目安装的 TypeScript 编译器检查新 API 的结果类型、异步输入、signal、必需 mapper 和非法参数。

三项都通过且保护文件未改，才记行为正确。这里没有把运行时测试称为完整 `npm test`：上游的 XO 与原 tsd 命令不是独立验收的全部组成。agent 可以自行运行它们，但结果不会替代父进程复验。

父进程使用同一套 Terse `snapshot`、`clones`、`newClones`，对两组执行对称的事后 token 重复计数；control 无需遵循 Terse 的决策流程，也不会因缺检索记录被判行为失败。评测保存修改前快照于父进程内存，源码和类型以外的保护文件、配置与锁文件修改会导致协议无效。Terse 组还要有基线检索、非空候选决策和与最终快照相符的检查报告。

`newDuplications` 仅是新增 token 序列组数，不代表业务上不必要的实现数；补丁一并保存，供评审判断职责和复用方式。无法完成、超时、输出截断、不同基线或协议违规的运行仍保留，不能当作零重复或从报告中静默剔除；无效配对不计算耗时差。

`agentMs` 是从启动 CLI 到结束的墙钟时间，包含工具调用、验证及传输重连；`evaluationMs` 是事后独立验收和分析时间，不计入 agent 工作耗时。复制工作区、依赖准备和父评测器给两组统一建立的初始基线均不计入 agentMs，因此该指标不是首次部署 Terse 的端到端成本。CLI JSONL 中的实际 token 使用、缓存 token、命令数和传输错误分别记录，不用估计值补空。模型字段是请求的模型标识，不声称已经验证服务端内部路由。小样本及连接开销不足以支持一般收益或显著性结论。

## 复现

需要已登录并可用的 Codex CLI、Node 24+、Git 和网络。在仓库根目录：

```sh
npm ci
npm run build
git clone https://github.com/sindresorhus/p-map.git .terse/p-map-upstream
git -C .terse/p-map-upstream checkout --detach 2ba3a002acac080c60c47ca1dfa2fad3e17f5b7c
```

在 `.terse/p-map-upstream` 中运行 `npm install --ignore-scripts --package-lock=true --no-audit --no-fund`，再回到 Terse 根目录：

```sh
npm run benchmark:agent -- --source .terse/p-map-upstream
```

旧提示路径默认是 `--workflow manual`。测试当前命令式接入用 `npm run benchmark:agent -- --source .terse/p-map-upstream --workflow commands`；该参数写入 plan 和 comparison，不覆盖历史结果。新版本 CLI 本身也提供更多引导信息，因此要逐字复现最初的手写接入观测，还需使用 PR #9 的历史实现，而非只切换此参数。

可以通过 `--codex <可执行文件>` 指定 CLI，通过 `--repetitions <1..10>` 改变配对数。改变次数后视为另一实验，不能与默认实验混称。执行保留本机用户配置以使用 Windows/网络设置，模型与推理等级由命令行统一覆盖；CLI 接口与 JSONL 用法参照 [OpenAI 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)。本次 CLI 版本和运行时保存在 JSON 中。

准备阶段安装会生成锁文件；运行记录锁文件哈希，并在产物根目录保存原锁文件。两组使用同一批依赖，但未来重新解析上游的版本范围可能得到不同依赖；严格复现应恢复随附的锁快照再运行 `npm ci --ignore-scripts --package-lock=true`，不能只凭相同 Git 提交声称环境完全相同。解压命令（仓库根目录）：

```sh
node -e "const fs=require('node:fs'); fs.writeFileSync('.terse/p-map-upstream/package-lock.json',require('node:zlib').gunzipSync(fs.readFileSync('benchmarks/p-map/observed/dependency-lock.json.gz')));"
```

完整产物写入 `.terse/agent-benchmark-*/`，包含预登记 plan、提示、JSONL、stderr、独立验收日志、补丁、重复证据、逐步结果和 comparison。运行中每 30 秒输出进度；时限到达后终止本次拥有的 agent 进程，失败也进入报告。不得将 CLI 登录文件或凭据复制进项目、报告或 CI。

实验结束后，可用 `node scripts/export-agent-benchmark.mjs --input <产物目录> --output <新的发布目录>` 导出便于审查的比较结果、补丁、重复证据和 gzip 压缩的依赖锁文件。锁文件解压后的 SHA-256 应等于报告中的 `dependencyLockHash`，无需把数千行第三方元数据混入实现 diff。导出器不覆盖旧实验，不发布机器路径、最终 agent 自述或原始事件流；CLI 诊断仅发布类别，事件流通过 SHA-256 标识并保留本地。分发上游派生代码时保留 MIT 许可。

常规 `npm test` 仅运行离线协议与统计测试，以及既有受控评测。真实模型实验不在 PR CI 中自动触发，避免测试结果依赖登录、模型费用和网络；实际对照结果必须来自单独的 live run。
