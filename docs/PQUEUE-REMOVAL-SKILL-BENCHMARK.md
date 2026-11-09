# 删除声明约束后的 p-queue Skill 真实会话复测

本轮从已合并 M5 删除声明约束的 `main daca32d` 出发，重跑 [首轮 p-queue Skill 任务](PQUEUE-SKILL-BENCHMARK.md)。产品 src/ 和 Skill 使用 main 原样字节；本轮只扩展 M6 观察、计分、发布与回归，不在会话中修改产品或提示以获得成功。

## 预登记

固定 p-queue v8.0.1 / `47a4f19ab3d4422e06cb1b618f4c45a11b5def30`，依赖锁沿用原 SHA-256 `7b8a942b4606345bd51f5eea912c0f4c43d9bc05c6274ae93e048b7a3393ab4c`。修改、删除、重构各两次，共六个全新独立会话，gpt-6.1-sol / medium，每次最多 600 秒。保留当前宿主配置与正常自动审批，关闭多 agent；不 resume，不补发指令，不人工修复、不替换失败或超时样本。运行方式沿用 [OpenAI Docs 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)。CLI 版本与运行环境由报告实际记录，不能把宿主版本变化当成 M5 因果收益。

提示和允许修改范围与首轮逐字相同：为 onEmpty/onIdle 添加可选 AbortSignal；退役 lower-bound.ts 并内聚二分插入；提取 #onEvent 为独立 waitForEvent 并委托三个公开等待入口。模型只收到普通业务需求、编辑边界及交付要求，没有 Terse、Skill、AGENTS 或命令提醒。宿主只调用实际 init，不替 agent begin、检索、决定或修改源码，不预置错误决策或替它填 remove。

原编译、任务运行时验收（修改 5 项，删除与重构各 4 项）、上游 AVA（45 通过/2 既有预期失败）和严格类型四组检查不变；同一份受保护验收用于 agent check 与父进程独立复验。上游与准备副本须在会话前健康，任务最初未满足，历史参考补丁仅在隔离预检中证明验收可达，不提供给模型。沿用等价平铺 tsconfig、验收导入前缀的最小迁移、独立可写依赖副本及 source/README 范围快照。

## 删除声明与修正的独立证据

保持原 `workflow` 的严格 pass 标准，新增独立 `removalWorkflow` / `removalSummary`，标识 `removalTracking: removal-declarations/1`。父观察额外保留真实 check 响应中的 undeclaredRemovals 和规则/等级，复用 runStates 的决策哈希与 remove。会话结束后独立读取 finalRunStates，防止将最终 check 后丢掉的声明当成完成。

- 主动声明：原严格阶段规则下，在首次源码或 README 编辑前有合法基线、检索和覆盖所有预登记删除目标的决策。删除目标任务为四次（两个删除文件、两个移除私有方法）；修改任务不需要删除，不能把空集合计作主动声明成功。
- 发现遗漏：观察到同一 run / baseline 的 check 报 REMOVAL_DECLARATION_MISSING / fail 等级，并包含实际缺失目标。只有验证失败、环境重试或 agent 自述不能计作发现。
- 补齐声明：在发现之后观察到新的决策哈希，remove 覆盖该次缺失目标与预登记目标。没有发现机会时不计修正成功；源码修正、恢复旧实现与修改理由本身不代替补齐声明。
- 修正完成：补齐之后，在同一 run 对最终状态执行所有配置验证，实际发现中已无遗漏/失败，最终决策仍保有对应目标。命令开始到完成及区间内的决策哈希必须稳定，并与会话结束时磁盘记录一致；同命令补决策并 check 等模糊区间保守地不给完成分，随后独立完整检查可以恢复。

declarationCheckCompleted 要求可观察的 Skill 读取、修改前 begin/检索/合法决策、单一基线、最终源码和 README 匹配、保护文件完整、四组验证全部通过及最终声明绑定。允许其最终状态为显式 needs-review，报告 finalCheckStatus 和 finalReviewRules；该字段仅表示声明约束的检查完成，**不将 needs-review 改称 pass，也不替代严格 workflow.completed**。成员引用不确定仍保留 M4 人工复核。

checkTraceComplete 单独记录所有尝试是否都有规则与删除字段；响应缺失、失败或未知样本不删除。没有自然遗漏时报告“没有观察到修正机会”，不推断自主纠错成功率。新字段缺失的历史观察保持原样，不回填，不能视作没有遗漏的证据。

行为正确性、自动阶段、精确/相似重复以及非盲复用/实际清理审查分别计分。逐份审查实际补丁，并检查 agent 是否在交付中披露剩余复核；M4 的保守提示不自动等同实际残留。耗时及决策格式重试仅为辅助。没有同期对照组；首轮数据只做描述性参照，不据此证明相对收益或因果改善。

## 执行、发布与保留

```sh
npm run build
node scripts/benchmark-skill.mjs --suite p-queue --source <固定上游工作区> --preflight-only
node scripts/benchmark-skill.mjs --suite p-queue --source <固定上游工作区> --repetitions 2
node scripts/export-skill-benchmark.mjs --input .terse/skill-agent-<id> --output benchmarks/skill/p-queue-removal-observed --archive benchmarks/skill/fixtures
```

模型启动前提交预登记输入，固定产品、Skill、脚本、提示、验收和上游/锁的字节哈希；会话运行期间不改动这些输入。新数据保存到 p-queue-removal-observed，归档绑定全部发布文件，上游源文本、锁及 MIT 许可同样保留。旧 p-queue、reuse、订单 Skill 与 p-queue-observed 的数据和归档不覆盖。原始事件、命令输出和本机路径留本地，以哈希绑定公开的观察、补丁、分析和源码审查。

CI 只执行离线证据和静态补丁回放，不调用模型、不安装上游依赖；完整四组行为证据来自本轮父进程独立复验。小样本、单一模型、宿主全局配置及只有五个产品源码文件的固定库仍限制外推。下文在六次实际会话结束后追加结果，不修改预登记规则或失败样本。
