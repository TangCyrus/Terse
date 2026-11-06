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
