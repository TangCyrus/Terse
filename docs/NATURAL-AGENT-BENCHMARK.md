# 复杂自然开发对照

本轮承接 #19，专门观察非预置问题。三个任务从 12 个源码模块组成的正常项目开始，包含领域选择、CSV 编码、archive、两类 job、namespace 集成、barrel 和 lazy plugin。已有行为验收通过，基线没有已知重复实现；没有 seed，也不在 begin 后安装修改。初始 patch 必须为空，startingHash 必须等于 baselineHash。旧 billing 模块是任务前仍受支持的合法 API，按新需求退役不表示基线已有缺陷。

## 预先登记的任务与运行

- customer-batches：游标、状态和 owner 过滤、重复 ID 拒绝、完整 CSV 批次、await 背压及错误传播。嵌入换行不能靠拆分完整 CSV 实现；新增调度逻辑合理，既有编码和金额校验应复用。
- billing-migration：移动旧 billing API，保留 archive、weekly/manual jobs、namespace download、公共别名和 lazy plugin 的契约，删除旧文件及所有残留路径。
- audit-delivery：独立且严格的审计授权、owners/statuses 选择、增加 ownerId 列的异步导出，并保留客户 owner 隔离。允许独立业务策略，既有 CSV 字段和金额验证不应另写一套。

每类两对，交替 arm 顺序，共 12 个对照运行。沿用 gpt-6.1-sol / medium，每阶段最多 600 秒。每个运行包含首稿与复核两个真实模型调用，因此共 24 次调用；两个阶段都使用现有非交互执行器与正常审批配置，不通过其它 agent 代做实现。每次调用为独立 ephemeral 会话，状态通过同一工作区承接，两组相同。此为受控的真实模型开发任务，不是外部开源项目实测。

首稿阶段由 agent 自行阅读、实现并运行行为验证，Terse arm 先检索和记录决策，但此阶段明确不调用 check。宿主立即保存该模型首稿、行为验收及独立精确重复/相似度/清理分析；宿主不修复、注入或改写任何源码。初稿检查机会由模型实际产出决定，而不是挑选人工反例。

复核阶段双方收到相同任务并独立自查。control 获得常规自查和相同运行时验收机会；Terse 在修改首稿前运行原 run 的完整 check，按发现自行决定修复，任何改动后再完整复验。宿主不会给 control 结构分析结果，也不会告诉 Terse 预登记的参考候选或人工审查结论。最终另由父进程重跑全部三份运行时验收及相同结构分析；没有额外 TypeScript 类型验证。

## 证据与判断

每个 arm 分别保存初始空 patch、模型 draft.patch / draft-analysis.json、最终 patch 与独立分析；两阶段原始事件各有 eventHash。合并的派生计量给 itemId 加 draft:/review: 前缀，保留实际 usage 和调用序列；任何阶段不完整不能被另一阶段的完成掩盖。agentMs 为两阶段耗时之和，不含父评测器的中间验收时间。

比较指标为首稿与终稿的行为、人工判定的职责重复与清理完成，以及同对差异；精确 token 与相似度只是证据，零发现不等价于没有重复。首稿和终稿均逐份非盲审查，保留具体理由与原始 patchHash。合理新增、不同授权职责与必要的新调度逻辑不算冗余。

只有自然首稿中的目标问题确实在 check 出现、随后源码变化、完整复验与父分析确认消失，才计为观察到修正。若直接避免问题，记录无修正机会；不得算成漏报或纠错成功。首稿行为错误、未知分析、未修正与协议失败均保留，不改为零、不替换或删掉样本。复核前不得重建基线、丢弃移除声明或以跳过验证换 pass。

所有运行原始起点匹配；首稿本身由两组各自生成，不要求首稿 hash 相同。若任一阶段修改保护文件或越界，即便最终恢复也记为协议无效。Terse 必须保存首稿阶段决策，首稿不得提前 check；复核第一个可核查的完整检查须对应首稿快照。

本轮只扩展任务与测量，不改产品分析器、完整 check、测试标准或历史数据。两阶段干预与有限样本不能单独支持一般自然重复率或因果保证；如果两组都没有问题，应如实报告未观察到收益。

## 复现与保留

```sh
npm run build
node scripts/benchmark-reuse.mjs --suite natural-complex --preflight-only
node scripts/benchmark-reuse.mjs --suite natural-complex --repetitions 2
node scripts/export-agent-benchmark.mjs --input .terse/reuse-agent-<id> --output benchmarks/reuse/natural-observed
```

运行前固定提交、输入字节哈希和任务标准。所有实际样本留存，新数据只写 natural-observed，并为其输入和全部发布字节另建冻结归档；三轮历史目录与归档不回填、不覆盖。原始事件和模型自由文本留在本地。CI 只运行离线预检、契约与证据校验，不调用模型。

本文先登记规则，完成实际会话和逐份审查后追加观测。执行方式参照 [OpenAI 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 实际观测（2026-11-06）

在固定提交 `07757da` 上完成 12 个运行、24 次真实调用，产品源码与 main `e7aee52` 相同；CLI 0.166.0-alpha.6，Windows / Node 24.20.0。全部阶段完成，12/12 协议有效，无替换、剔除或另抽样。原始日志保存在本地 .terse/reuse-agent-7RkJMc，新 [报告](../benchmarks/reuse/natural-observed/comparison.json)、[首稿/终稿审查](../benchmarks/reuse/natural-observed/functional-reviews.json) 和 [冻结输入](../benchmarks/reuse/fixtures/07757da03ec1856fb9d5aba53270379805490d70.json.gz) 绑定 31 份输入和 86 个发布文件。宿主对每个运行核对初始 patch 为空及 startingHash 等于 baselineHash。

**本轮没有观察到 Terse 相对 control 减少改写式重复或清理遗漏。** 两组各六份首稿已通过独立三份运行时验收，并按预登记的复用/清理标准达标；六份终稿也相同。首稿与终稿的新增精确重复、相似实现和清理发现均为 0；人工审查确认编码规则共用，迁移均实际删除旧模块并更新所有调用。这里的 functional 计分限于固定验收、协议和预登记结构标准，不是对所有输入与契约边界的完整正确性证明。

- 四个 customer-batches 首稿都复用 selectCustomerOrders 与 renderOrderCsv，仅新增游标、ID/size 校验和顺序交付逻辑，复核后源码均未变化。
- 四个 billing-migration 首稿都迁移了 API 别名、archive provider、weekly/manual jobs、namespace download 与 lazy plugin，旧文件被移除。两个 control 将原 exportOrders 改成新 billing 的薄委托，两个 Terse 保留由新 billing 委托原 exporter；都只有一份选择与编码管道。一个 control 在常规复核中改动了 download 参数映射，其余迁移源码不变。
- 四个 audit-delivery 首稿均保留独立严格授权与 owners/statuses 选择，共用 ORDER_HEADER、csvCell、orderRecord，并 await 每次交付；复核后源码不变，客户隔离 API 未改动。

六个已有候选均命中。六个 Terse 复核阶段的首次完整 check 都对应各自模型首稿，且均 pass、没有目标问题发现；observedCorrection 均为 false，应解释为没有观察到结构性修正机会，不能算工具漏报或纠错成功。首稿阶段没有提前 check，六次完整 check 均执行全部配置验证；decide 共七次成功、无失败/重试，另有三次帮助查询。控制组有同等常规复核机会，不以只有 Terse 能复核来制造优势。

辅助 agentMs 两组分别为 control 545.3 秒、Terse 620.0 秒，约多 13.7%；均为两阶段调用之和，不含父进程的中间验收。两阶段干预、每类两对和非盲审查仍不足以推断一般自然重复率、召回率或跨项目收益。基线虽有 12 个源码模块，仍是受控示例，不能替代大型项目实测。

### 不计分的兼容边界补充观察

阅读补丁时发现固定验收未覆盖的边界，随后对两个相关任务的全部八份终稿统一执行了补充探查，结果附在审查文件的 supplemental 中，标记 scored:false 并绑定最终 patchHash。没有改动预登记测试、主指标、模型源码或重新调用模型。

- 一个 Terse 批次实现额外拒绝空字符串 afterId，即便该 ID 存在；其它三份批次实现支持该边界。此输入未进入固定验收，不能从固定 pass 推断它已被验证。
- 两份 Terse 迁移将 downloadOrders 的 status 映射为 paidOnly，而原实现忽略该可选参数，补充探查复现了输出差异。一份 control 首稿也做了该映射，但常规复核自行移除了它；另一份 control 保持了原语义。此变化既不是重复实现，也不是清理遗漏，Terse 的结构检查没有指出它。

这些补充结果说明固定验收与结构零发现仍可能漏掉兼容边界；不把它们隐藏成“全部行为完全正确”，也不事后加入主分数或据两对样本宣称工具造成退化。评测的主要问题仍未得到正收益证据：各组自然首稿本来就复用并完成清理。四轮数据各自冻结，旧观测与归档全部原样保留。

自动评审后的回归补严了计量边界：双阶段运行只有首个完整复核检查在已保存 draftHash 上发现目标问题，才可计为修正首稿。先对干净首稿 pass、复核中另引入问题再消除的序列不能获得此项修正计分；这类后续警告仍留在原始检查轨迹中。本轮 12 个结果在更严格规则下均不变，冻结归档仍保存实际运行时 07757da 的输入，没有重跑模型或修改观测文件。
