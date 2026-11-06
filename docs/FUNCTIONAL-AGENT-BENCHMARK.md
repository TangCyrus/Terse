# 功能效果 agent 对照

本轮 M6 将主要验收改为：agent 是否保留行为正确性、复用或修改合适的已有实现、完成旧路径清理，以及允许合理新增和保留真正不确定的引用。耗时、源码行数和 token 重复计数均为辅助指标，不单独决定功能达标。

## 预先确定的任务与判断标准

复用 [已有六类任务](../scripts/evaluation-cases.mjs)、订单项目和原有三个行为验收文件，两组都收到“保持兼容、避免平行实现、允许独立职责”的要求，并允许编辑整个 src/ 树和新增模块。不得通过只允许原文件来预先强制复用。control 按常规开发；terse 额外运行检索、显式决策、完整 check。模型、推理设置、时限、起点和验收相同，每个任务默认一对实际会话，交替执行顺序。

- 修改：付费筛选接入原有导出职责；权限、金额校验和 CSV 编码保留一份实现。仅在入口筛选后委托原 exporter 也是合理复用。
- 删除：旧模块实际移除，调用方迁移；不能只看运行测试，因为保留旧实现也能通过测试。
- 重构：实现迁入 reporting，原 API 为薄 facade 或转发；不能留下两份完整函数体。
- 合理新增：独立通知队列实现幂等、校验和不可变输入；不要求挤入 CSV 导出模块。
- 独立权限职责：审计导出与客户隔离契约分别正确。共享格式化可以，直接绕过权限或破坏客户 API 不行；token 相似提示需结合职责判断。
- 动态引用：旧模块移除、入口迁移、运行时选择当前 exporter；静态覆盖不足可保留 review，不因 needs-review 判行为失败，也不能删除真实移除声明来获得 pass。

最终逐份审查补丁，检查上述职责和残留，而不是让检测器给自己的“零发现”背书。审查者为本次开发 agent，非独立盲评；结论绑定 patchHash 并记录理由。缺少审查、协议不完整或行为错误的运行不能算功能达标。所有失败和无效会话保留，不从分母删除。

## 执行与证据

```sh
npm run build
node scripts/benchmark-reuse.mjs --preflight-only
npm run benchmark:reuse
```

执行器复用 [已有实际会话传输](../scripts/lib/agent-runner.mjs) 和 [公共项目准备](../scripts/lib/evaluation-project.mjs)，保留本机正常配置与审批机制。非交互 JSONL 方式参照 [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode)。该实验不使用其他 agent 协作实现任务。运行时不并行执行工程测试；模型实验不进入 CI。可用 --codex 指定已登录 CLI，--repetitions 1..10 设置配对次数，改变条件后创建新的观测目录。

本地 `.terse/reuse-agent-*/` 保存预登记 plan、全部提示/事件/日志、独立验收、源码补丁及完整 Terse 记录。父评测器重新执行全部三个验收文件，核对配置、测试和源夹具哈希，并独立调用相同 token/清理分析器以便两组可比。删除任务的未完成起点会通过行为验收，其他五个任务必须失败；预检明确断言这一区别。

acceptanceHash 从运行前保存的验收文件哈希构造。运行后验收文件缺失、改名、被目录替换或不可读时，记入 tampered，并保留 correct/protocolValid 为 false 的结果；不因再次读取缺失验收文件抛错而丢掉本轮样本或中止后续会话。无效运行继续留在分母中，不计为功能成功。

源码快照、解析、重复与清理分析统一由 analyzeEvaluation 捕获失败。配置 JSON 损坏或被目录替换导致快照失败时，保留 duplicationError，newDuplications 为 null，workflow 不会用缺失的快照验证成功；协议无效的结果仍可保存，后续样本继续评测，不将未知分析结果记为零重复。

实际 agent 结束后，在该目录写 functional-reviews.json，为每次运行填写 artifactId、patchHash、functional 布尔值和 reason。用现有导出器发布到新目录：

```sh
node scripts/export-agent-benchmark.mjs --input .terse/reuse-agent-<id> --output benchmarks/reuse/<new-observation>
```

导出器验证每份审查与运行补丁标识一致，再发布审查、补丁和重复证据，省略原始事件、最终自由文本和机器路径。报告 kind 为 controlled-agent-comparison，区别于外部开源项目数据；本夹具无额外依赖锁，不生成虚构的第三方锁文件。耗时和配对仍记录，但不作为主要通过门槛。

fixtureHashes 保留会话起点的原始字节哈希；发布时先验证原文件未变化，再另生成 fixtureCanonicalHashes，仅将 CRLF 规范化为 LF 后计算。原始测量哈希不改写。reviewHash 对审查数组的 JSON.stringify 表示计算；补丁哈希始终对原始字节计算，并通过 .gitattributes 禁止 Git 换行转换。

历史观测的输入与当前 HEAD 分开校验。[冻结归档](../benchmarks/reuse/fixtures/6299edae60f3b778a0889feaf070bae7c4682c95.json.gz) 保存当时 13 份夹具的精确 UTF-8 文本（包括原换行符）、revision 和 26 个原发布文件的 SHA-256。来源为已记录提交 6299eda，恢复 LF/CRLF 后逐一匹配既有 fixtureHashes，再核对 fixtureCanonicalHashes；没有用新源码重算并替换旧哈希。CI 读取归档验证原始与规范化哈希，并逐字节校验整个 observed 目录；不再要求历史 oracle 等于当前 oracle，也不依赖浅克隆之外的 Git 历史或网络。

归档只服务历史证据校验；新运行仍由当前夹具和预登记规则生成自己的哈希。导出器仍拒绝运行后已变化的夹具，新实验必须发布到新目录，不能覆盖或回填旧观测。

## 历史漏报与当前回归

受控评测的 rewritten-copy 另写一套 owner 过滤、金额校验和 CSV 编码，更换循环、变量和拼接方式后，历史版本通过行为验收、token 新重复为 0，Terse 为 pass，人工判断仍为冗余。冻结归档保留该旧预期，原始真实会话观测不变。

M3 #17 已合入 main 141a123，当前 [自动回归](../test/evaluation.test.mjs) 预期为 needs-review、POSSIBLE_DUPLICATION、possibleDuplications: 1，精确 token 组仍为 0。行为验收保持通过，authoredReview.functional 仍为 false；改成委托已有实现的版本继续 pass，无相似实现提示。该规则给出共有字段、操作和字面量的复核证据，不证明语义等价，也不能保证没有其他职责重复；合理新增、独立职责及不确定引用负例仍保留。

## 实际观测

取得本轮数据外发授权后，于 2026-11-05 在固定提交 `6299eda` 上顺序完成六类任务共 12 次实际会话，无试跑补丁、替换样本或中止会话混入。模型为 gpt-6.1-sol / medium，CLI 为 0.166.0-alpha.6，Windows / Node 24.20.0。产品代码来自已合并 main 4ad831a，不依赖仍待审的 M5 PR #15。报告、12 份补丁和逐份审查见 [观测目录](../benchmarks/reuse/observed/comparison.json) 与 [功能审查](../benchmarks/reuse/observed/functional-reviews.json)。原始事件、提示和父进程验收日志在本地 .terse/reuse-agent-PnOHwE，用哈希绑定，不公开自由文本。

- 两组各 6/6 通过独立的三个运行时验收文件，全部 12 次协议有效。该夹具没有额外编译或第三方测试，不将它描述为完整 TypeScript 类型验证。
- 按预登记标准逐份审查后，两组各 6/6 功能达标。修改均在入口筛选后委托原 exporter；删除均移除旧模块并迁移导入；重构均将函数体迁往 reporting，原 API 保留薄转发。
- 通知任务均新增独立模块；审计任务均提取单份 CSV 序列化，客户 owner 隔离与审计授权分别保留。新增文件没有被视为失败。
- 动态任务均按 name 的 orders 分支导入明确模块，未知名称拒绝，不忽略入参；旧模块实际移除，导入可静态解析，因此无需不确定引用 review。原人工变体的任意动态路径仍保留 review；本次不能证明所有动态消费者都已覆盖。
- Terse 的五个预登记已有候选全部出现在基线检索中；新增任务不定义预期已有候选。六次决策各成功保存一次、无失败或重试，六份完整 check 均为 pass；两次会话另查询了帮助。
- 两组新增 token 重复均为 0；删除、重构和动态任务的成对补丁字节相同。本轮没有观察到 Terse 相对对照组的功能或重复改善，也没有自动修复重复的实际事件证据，不能宣称因果提升。

以上是历史版本的结论：六类任务上的接入、复用、清理和合理新增可用并保留行为正确性，当时的 rewritten-copy 未检出。适配 main 后，该已知反例现会进入复核；本次只更新当前回归及证据校验，没有重新运行这 12 次模型会话，不能把旧比较结果改写成新规则的 agent 收益。对所有职责重复的保证仍未达到，耗时继续只作辅助记录。

每类每组仅一个样本，任务与验收可见，部分需求已给出迁移目标；两组均收到避免平行实现的要求。开发 agent 的非盲补丁审查也有主观性。本轮结果不能推广为一般正确率、检索召回率、误报率或漏报率，更不意味着工具对所有项目均没有作用。
