# M6：多文件 TypeScript 项目 agent 对照

本评测扩展 [p-map 实验](AGENT-BENCHMARK.md)，使用真实开源项目 [sindresorhus/p-queue v8.0.1](https://github.com/sindresorhus/p-queue/tree/v8.0.1)，固定提交 `47a4f19ab3d4422e06cb1b618f4c45a11b5def30`。上游派生补丁遵循随附的 [MIT 许可](../benchmarks/p-queue/LICENSE)。它有五个源 TypeScript 文件，涉及队列调度、优先级插入、并发限制、时间窗口与事件等待，比此前 p-map 的单一新增 API 任务涉及更多状态和文件关系；它仍是规模有限的库，不代表大型应用或 monorepo。

本次使用已合并 M5 优化的 Terse `9f1187f`，通过候选 ID、`decide` 和 `check --summary` 接入。没有同时修改检索、重复算法或产品接口。三个任务由本评测设计，不声称来自上游维护者的真实 issue。

## 实际结果

2026-11-05 的 [正式结果](../benchmarks/p-queue/observed/comparison.json) 包含 12 次真实会话、6 个有效配对。两组均 **6/6 行为正确、新增 token 重复为 0**，没有超时、保护文件改动或编辑越界。因此本轮没有观察到 Terse 额外减少重复实现，不能把零重复当作 Terse 带来的改进。

以下耗时按 control / Terse 列出，均为秒；每类任务每组仅两个样本：

- 修改：第一对 115.775 / 118.851，第二对 92.260 / 108.865；均值 **104.0 / 113.9**。
- 删除：第一对 71.374 / 100.642，第二对 64.853 / 97.936；均值 **68.1 / 99.3**。
- 重构：第一对 97.348 / 135.217，第二对 100.443 / 162.404；均值 **98.9 / 148.8**。

全任务均值为 **90.3 / 120.7 秒**，本机观察接入组平均增加 30.3 秒。每次准备为 3.663–7.146 秒，事后独立验收与分析为 7.125–7.971 秒，均单列于 JSON，没有计入 agentMs。不能把差值全部归因于 Terse 算法：它包含模型实现选择、命令轮次、Windows 审批重试和检查；例如第一次 control 修改额外尝试的 lint 因 Windows 路径和 AVA 配置超时未完成，第二次 Terse 重构自行修正了 helper 泛型编译错误。两者都保留实际耗时，没有为更好看的速度重跑。

逐份查看补丁后，两组修改任务都扩展现有 `#onEvent`；删除任务都移除旧模块及导入、把二分插入放进现有 enqueue；重构任务都增加一份 helper、由三个方法调用并删除私有实现。补丁与 token 结果一致，说明这些明确职责的任务中，未接入 Terse 的基础 agent 已经能复用和清理。新增文件不一定是冗余，减少源码总行数也不是本次正确性条件。

六次接入的观察还暴露出两个改进方向：

- 修改两次最终为 `pass`；删除两次为 `needs-review`，规则为 `REMOVAL_REFERENCE_UNRESOLVED`，原因是 `eventemitter3` / `p-timeout` 的外部导入不在源码快照。重构两次还包含私有成员的 `REMOVAL_REFERENCE_UNCERTAIN`。四次均通过所有独立验证，复核提示不等于行为失败，也没有为了消除提示而省略删除声明。
- 五次写决策首次成功，没有复现历史的 decision/disposition 字段错误。第二次重构先读取帮助（本地事件 item_7），随后把 `--input` 与 `--candidate` 同传（item_9），得到 `INVALID_ARGUMENT`；去掉额外标志后成功（item_10）。因此命令式接入减少了简单记录的手写格式负担，但复杂输入仍存在参数组合摩擦。该次泛型修正是另外的实现错误，不能计为决策格式错误。

后续可分别用独立 M2/M4 切片验证外部导入造成的清理复核范围，用 M5 切片改进复杂决策参数指引；本次 M6 保持产品实现不变，没有针对观测临时放松规则。每份补丁、重复证据、任务和验收哈希、实际 CLI usage、命令数、最终 Terse 状态以及 [依赖锁快照](../benchmarks/p-queue/observed/dependency-lock.json.gz) 均已发布。原始提示和日志保留于本地 `.terse/agent-benchmark-hpetfT`。`terseRevision` 指产品起点 `9f1187f`；复现新增任务及多任务脚本应使用包含本 PR 的提交。

## 后续 M4 清理回放

M4 后续切片用相同的 p-queue 提交、平铺配置、依赖和已发布补丁，在四个新副本中建立新 run，再执行 check；没有重新调用 agent，也没有修改上面的历史时间或观测文件。

- `delete-pair-1-terse` / `delete-pair-2-terse`：从 `needs-review` 变为 `pass`，不再因 `eventemitter3` / `p-timeout` 的普通外部依赖导入产生 `REMOVAL_REFERENCE_UNRESOLVED`。
- `refactor-pair-1-terse` / `refactor-pair-2-terse`：仍为 `needs-review`，移除无关外部导入提示，保留 `REMOVAL_REFERENCE_UNCERTAIN`。声明删除的私有成员没有被省略。

四份原始补丁均通过 SHA-256 核对；每个案例的编译、4 项任务验收、上游 45 项通过及 2 项预期失败、类型验收都通过，新增 token 重复为 0。原始回放报告保留于本地 `.terse/m4-pqueue-replay-lqMxI6`。回放验证的是清理分类变化，不能作为新的 agent 正确率、提速或减少重复的证据。

复核时，从固定原版和本文所列等价配置建立基线，保留对应任务的四项 verification，记录实际删除目标，再应用 observed 中对应 patch 并运行 check。无需放宽策略或省略私有成员声明。离线回归 `node --test --test-name-pattern="M4 " test/terse.test.mjs` 覆盖声明依赖、路径/工作区反例、元数据完整性与成员不确定性；规则与边界见 [M4 使用说明](../README.md#m4-清理与残留引用)。

## 后续 M5 复杂决策回放

M5 后续切片使用固定原版建立新 run，读取原始 `refactor-pair-2-terse/item_9` 的决策文件与候选 `7cb93ad172eb31414cd4`，保留 `--input` 和 `--candidate` 同用的参数组合。原调用被互斥检查拒绝；新调用一次以退出码 0 保存，完整保留 4 个候选的处置/理由及 `PQueue.#onEvent` 删除声明，input 文件内容未改动，没有执行项目 verification。

candidate 在 input 模式下是校验断言，文件仍是完整决策；未知、失效或未列入输入的 ID 继续报错，其余冲突参数仍拒绝。指南分别提供简单/复杂模板，后续 benchmark 提示复用这些模板，避免在简单命令上叠加输入文件。契约见 [CLI 文档](CLI.md#决策与低往返接入)。

这是确定性 CLI 回放，不是新的自主 agent 会话，也不是提速或普遍消除重试的证据。历史观测及原事件保持不变；本地回放记录在 `.terse/m5-input-replay-byyHpO/replay.json`，绑定原始事件与输入文件哈希。离线回归覆盖候选断言、每候选处置、符号删除、失败不覆盖记录、基线检索和禁止混合覆盖参数。

## 固定任务和独立验收

[project.json](../benchmarks/p-queue/project.json) 固定源码、模型请求名 `gpt-6.1-sol`、medium 推理、每会话 600 秒、每任务两次配对及编辑范围。每个任务、每组、每次重复都从同一原版独立复制，不叠加前一个任务的实现。

- **修改**：[需求](../benchmarks/p-queue/modify.md) 为 `onEmpty` / `onIdle` 增加取消等待参数；[5 项验收](../benchmarks/p-queue/modify.mjs) 覆盖已取消信号、原因身份、等待期间取消、其他等待者和工作保留、成功和取消后的监听器清理。
- **删除**：[需求](../benchmarks/p-queue/delete.md) 删除内部 `lower-bound.ts`，由现有 PriorityQueue 承担二分插入；[4 项验收](../benchmarks/p-queue/delete.mjs) 检查模块和引用消失、优先级及同级 FIFO、过滤和出队。固定 300 项输入的优先级转换计数限制比较工作，避免用反复排序或线性扫描冒充原算法；该限制不是严格的渐近复杂度证明。
- **重构**：[需求](../benchmarks/p-queue/refactor.md) 提取共享 `waitForEvent`，三个公共等待方法直接调用，删除旧私有路径；[4 项验收](../benchmarks/p-queue/refactor.mjs) 结合 TypeScript AST、独立 EventEmitter3 实例、过滤器、其他监听器、空队列与全部完成的语义区别。

每次完成后由父评测器独立执行上游 TypeScript `tsc --noEmit`、上述任务运行时验收、原版 AVA 运行时测试、任务类型验收。原测试基线为 **45 项通过、2 项预期失败**，分别为 `.add() - handle task throwing error` 和 `.add() - timeout with throwing`；退出码和计数均需匹配，不能把预期失败说成新增失败或 47 项通过。这不是完整的上游 `npm test`，未声称覆盖 XO 和全部 tsd 测试。

任务验收和类型文件在仓库外部的固定位置，供两组阅读；父进程保存其哈希，保护配置、锁文件和非任务文件，并检查编辑范围。每个任务的运行时验收在未修改基线上必须失败。验收可见，因此这是给定测试的工程任务对照，不能解释为隐藏测试上的泛化能力。

## 配置准备与测量边界

p-queue 的 tsconfig 继承 `@sindresorhus/tsconfig`。当前 M2 仅支持快照覆盖的仓库内配置继承，不能直接解析这个依赖包配置。评测先使用上游编译器 `--showConfig` 生成等价的平铺配置，同时应用于两组，并比较全部有效编译选项、原始源文件列表、动态 include 和规范化后的 exclude。保留严格检查和动态文件发现，不固定旧 files 列表，允许任务删除或增加源文件。

这项准备记录在结果的 `preparation`，且副本中的配置禁止 agent 修改。它让本次任务能够被现有 Terse 分析，不能据此声称 Terse 已原生支持包式 tsconfig 继承，也不能把准备后的实验推广到无需人工准备的任意项目。

共 12 次真实 CLI 会话，按任务和重复次数交替 control→terse / terse→control，顺序见结果数组。使用同一个已安装依赖树、同一份依赖锁、相同验收和时限，不恢复会话。CLI 保留本机 Windows/代理配置，以 `--approve-for-me --disable multi_agent --ephemeral` 执行；不使用跳过权限限制的选项。

Windows 受限令牌下，tsx 可能在测试启动前因 `os.userInfo()` 报 `uv_os_get_passwd ENOMEM`。两组收到相同运行说明：对提供的检查使用正常自动审批重试，禁止改源码或配置绕过初始化错误。重试时间包含在 agent 耗时中。正式测量前已单独验证上游编译、测试和 CLI 执行环境，环境预检不算任务样本。

正式实验前中止过一次评测器试跑：生成的 `terse.config.json` 没有登记到 Git 基线，被错误列为范围外文件。该轮已完成的修改任务 control / terse 分别为 93.800 / 104.562 秒，两者行为通过、新增 token 重复为 0，但协议标记无效；第三次会话中止，没有独立验收结果。修复基线登记、增加启动前干净状态断言后，重新开始全部 12 次会话。没有沿用试跑的补丁或修改验收；原始记录保留在本地 `.terse/agent-benchmark-klfguy`，试跑不并入正式均值。

- `agentMs`：启动 CLI 到退出的墙钟时间，包含阅读、实现、工具调用、检查、审批重试和网络开销。
- `preparationMs`：每次复制源文件、完整依赖树、平铺配置、分析预检和建立基线的时间，单列且不计入 agentMs；首次 clone / 安装依赖不计入这两个指标。
- `evaluationMs`：父进程在 agent 结束后执行独立验收、重复分析和证据收集的时间。
- `newDuplications`：两组使用相同 Terse token 检测器事后计数，阈值 50 tokens / 5 行。它不等同于语义重复或多余职责，需要结合补丁判断；分析失败记 null 和错误，不能记作零。
- `correct`：四项独立验证均通过且保护文件未变。`protocolValid` 另检查会话完成、工具事件、编辑范围、重复分析、对照组未使用 Terse，以及接入组的基线检索、决策和最终报告。

接入组要求记录真实删除目标，包括重构时的私有成员。当前 M4 对成员引用保留 `REMOVAL_REFERENCE_UNCERTAIN`，因此代码验收通过仍可能是 `needs-review`；不得为了获得 pass 而省略删除声明。`terseStatus` 和 `terseRules` 与独立行为正确性分开保存。

每个任务内按任务 ID 和重复编号配对，不跨任务拼接。无效会话、失败和超时均保留；无效配对不计算耗时差。计时期间不并行运行 Terse 工程测试，仍未隔离全部系统背景负载。每类任务每组只有两个样本，墙钟时间只作描述性结果，不能推断统计显著性、普遍收益或跨模型提升。

## 复现

需要 Node 24+、Git、可用网络及已登录的 Codex CLI。先构建 Terse，再准备固定上游及开发依赖：

```sh
npm ci
npm run build
git clone https://github.com/sindresorhus/p-queue.git .terse/p-queue-upstream
git -C .terse/p-queue-upstream checkout --detach 47a4f19ab3d4422e06cb1b618f4c45a11b5def30
```

在上游目录解压已发布的 `dependency-lock.json.gz` 为 `package-lock.json` 后，运行 `npm ci --ignore-scripts`。也可首次 `npm install --ignore-scripts --package-lock=true`，但解析出的依赖可能不同，需作为新的实验保留锁文件，不能替换历史锁快照。

回到 Terse 根目录执行：

```sh
node scripts/benchmark-agent.mjs --suite p-queue --source .terse/p-queue-upstream --preflight-only
npm run benchmark:agent -- --suite p-queue --source .terse/p-queue-upstream
node scripts/export-agent-benchmark.mjs --input .terse/agent-benchmark-<id> --output benchmarks/p-queue/<new-observation>
```

`--preflight-only` 不调用模型，仅预检上游、准备配置及未完成任务的验收；仍读取 CLI 版本。正式运行顺序调用实际 agent，不在 CI 中执行。默认 p-map 入口保持兼容。p-queue 报告使用实验格式 `schemaVersion: 2`，增加 tasks、配置准备和任务 ID，不改变产品 CLI 的 v1 契约。

发布器只创建新目录，保留逐次结果、补丁、重复证据和压缩依赖锁。原始提示、事件流、进程日志和完整 Terse run 留在本地 `.terse/agent-benchmark-*`，用哈希绑定；不上传 agent 的最终自由文本或机器路径。离线 CI 验证配对、配置不放宽、增删文件补丁采集和已发布数据的哈希，不需要模型或登录。
