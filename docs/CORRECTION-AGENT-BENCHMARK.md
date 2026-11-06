# 发现与修正的真实 agent 对照

前两轮六类任务的两组都完成了复用和清理，未产生需要工具纠正的真实事件。本轮以 main c5abe42 的产品代码为起点，补充更容易暴露改写式重复与残留引用的任务，验收重点是发现及修正过程，耗时仍为辅助。原 observed、optimized-observed 和两份冻结归档保持不变。

## 运行前固定的任务与标准

每个任务各运行一次 control 和 Terse，共八次真实会话，交替顺序；沿用 gpt-6.1-sol / medium、相同源码、可编辑范围、三份运行时验收和每次 600 秒时限。允许修改整个 src/ 并新增合理模块，双方均须保持行为、避免平行实现和完成迁移，不限定必须采用某份参考实现。

- **stream-paid，自然开发：** 增加支持 await 背压的逐行 paid 导出。编码规则与原 exporter 重叠，但入口形态不同；带换行的客户字段不能通过拆分完整 CSV 行来实现。离线反例证明另写循环可通过行为验收、精确重复为零而触发实现相似度；抽取共享选择及格式化则能通过。
- **cleanup-indirect，自然开发：** 删除旧 exporter，并保留经过 providers barrel 的 archive API。仅下载行为通过不能证明间接消费者已迁移；离线反例保留此运行时盲区，父分析须指出 providers 的残留引用。
- **rewrite-resume，接手修复：** 基线建立后安装明确标注的继承 WIP：已通过行为的改写式 paid 复制。它来自现有人工反例，绝不计为 agent 自发制造的重复。
- **cleanup-resume，接手修复：** 基线建立后安装行为已通过但旧文件仍在的部分迁移，要求完成旧实现清理。它同样属于预置问题，不是自然遗漏率样本。

接手任务在两个 arm 的相同原始基线上安装相同 WIP，额外记录 startingHash；配对还必须匹配实际起始源码。Terse 组的检索由父进程在 WIP 安装前真实执行并保存，返回原基线候选和现有决策/验证指南，不能把安装后的检索回填为原基线证据。两组都先检查继承工作：control 先运行相同的行为验收，Terse 先选择并记录决策、运行完整 check，再自行修复。此程序有意检验“拿到提示后的修复能力”，不是工具自然发现率或使用率。

父评测器保存 initial.patch、initial-analysis.json 及各自哈希，对两组独立运行相同的精确重复、相似度和清理分析。原始事件中的每次 check 返回快照、规则和验证状态，报告只发布所需字段，不公开原始日志或最终自由文本。

## 发现与修正如何判断

只有实际工具事件中出现目标规则，才算 warningObserved。observedCorrection 还要求：同一基线下的该检查完整运行所有配置验证且行为通过；之后出现另一份对应最终源码的完整 pass；源码确有变化；父分析确认精确重复、相似实现及清理发现均消失。接手任务的首次相关发现必须对应预登记 startingHash，缺少这一检查记为协议无效。仅查询帮助、读取报告、跳过验证、检查输出不完整、未变化的反复运行、只有最终 pass 或父检查仍有残留，都不能计为提示后的修正。

自然任务若直接复用并清理，记录“未观察到修正机会”，不算漏报，也不冒充工具纠错。功能达标另需独立行为验收、协议有效及逐份补丁审查；父分析零发现不等价于职责无冗余。每份人工审查绑定 patchHash，明确共享规则与残留引用，开发 agent 的非盲判断仍有主观性。

全部失败、无效、未修正和无机会样本留在分母中，不替换样本或为获得成功而反复重抽。两个自然任务和两个预置修复任务分开报告；检查轨迹只能支持先提示后修正的观察，不能独自证明因果作用或普遍收益，也不代表所有改写或间接引用均可发现。

## 执行与保存

```sh
npm run build
node scripts/benchmark-reuse.mjs --suite challenge --preflight-only
node scripts/benchmark-reuse.mjs --suite challenge
node scripts/export-agent-benchmark.mjs --input .terse/reuse-agent-<id> --output benchmarks/reuse/challenge-observed
```

复用现有执行器与导出器。预检不调用模型，预置问题与清理任务应通过行为、stream-paid 起点应失败。真实会话期间不并行运行工程测试。运行前固定提交和输入哈希，发布时再核对原字节；完成后为本轮另存输入与全部发布文件的冻结归档。没有改变产品分析器、检测策略、完整 check 或三份配置验收。

本文件先登记规则，再追加下方观测。相关执行方式沿用 [OpenAI 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)，模型实验不进入 CI。

## 真实观测（2026-11-06）

在固定提交 `9a7f559` 上完成四类任务、共八次真实会话，产品源码与 main `c5abe42` 相同。CLI 为 0.166.0-alpha.6，Windows / Node 24.20.0；全部完成，无中止、替换或剔除。新 [报告](../benchmarks/reuse/challenge-observed/comparison.json)、[逐份审查](../benchmarks/reuse/challenge-observed/functional-reviews.json) 和 [冻结输入](../benchmarks/reuse/fixtures/9a7f55918fc31ce0be38f24dc1ec4cbbfaa1dfa3.json.gz) 绑定 17 份输入与全部 42 个发布文件。原始提示、事件和验收日志留在本地 .terse/reuse-agent-D9CphU，以哈希标识。

**接手修复：Terse 两次均观察到完整修正链，control 也均修好。**

- rewrite-resume：初始改写式复制行为通过、精确新增组为 0，相似实现为 1。Terse 的 item_6 对同一 startingHash 返回 POSSIBLE_DUPLICATION / needs-review；随后 agent 为原 exporter 增加可选 paid 筛选，将 paid API 改成薄委托。item_8 的完整复验 pass，父分析与补丁审查确认第二套编码已消失。control 采用同一最终补丁，也通过验收。
- cleanup-resume：初始下载迁移行为通过，但旧文件仍在。Terse 的 item_6 返回 REMOVAL_REMAINS / fail；agent 随后实际删除 legacy.ts，保留现有调用迁移。item_9 完整复验 pass，父清理和补丁审查确认无残留；control 也完成相同清理。

以上两次的 warningObserved、seededCheckpoint、observedCorrection 均为 true，行为在警告和最终检查时均通过。它们验证工具能够指出已暴露问题、真实 agent 能在提示后修复，不表示问题由 agent 自发生成，也不能证明没有工具就修不好。

**自然开发：两个任务的两组都直接避免了问题，没有观察到修正机会。**

- stream-paid：control 抽取独立的 orderCsvRows 生成器；Terse 在原模块抽取 exportOrderRows 生成器。原 CSV API 与新的 await 流式 facade 均共用单条选择、金额校验、编码路径，带换行字段与背压验收通过。Terse 仅一次最终 check 即 pass，无相似度/精确重复发现，observedCorrection 为 false；不是工具漏报或纠错成功。
- cleanup-indirect：两组均删除旧文件、迁移下载 import 和 providers re-export，保留 archive 的原 alias 与 API。Terse 首次最终 check 即 pass，warningObserved / observedCorrection 均为 false。离线残留反例证明检测器能指出 barrel 引用，但实际会话没有留下该遗漏，不能将反例能力当成真实修正事件。

全部八次协议有效，两组各 4/4 通过独立三份运行时验收和开发 agent 的非盲补丁审查。最终新增精确重复、相似实现与清理发现均为 0；四个已有候选均命中，四次 decide 各成功一次、无失败或重试，另有一次帮助查询。Terse 共六份实际 check 报告：两类接手任务各两份，两个自然任务各一份，所有报告都执行完整配置验证。此夹具仍没有额外 TypeScript 类型验证。

辅助会话耗时为 control 合计 207.2 秒、Terse 257.6 秒，约多 24.3%；不作为功能门槛，接手任务还包含预登记的首次 check。自然任务与接手任务的提示/起点不同，不能合并成自然重复率或漏报率；每类每组仅一个样本。相对 control 的最终行为、复用和清理改善仍未观察到，本轮新增的结论是两条可核查的“先发现、后修正”真实轨迹。

发布过程在本地重新解析全部原始事件并核对 eventHash、初始/最终 patchHash 和 correction 推导；CI 不需要原始日志或模型，校验冻结的输入、全部发布字节、检查轨迹和审查绑定。前两轮观测及归档逐字节保持不变。
