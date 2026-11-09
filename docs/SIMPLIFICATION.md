# 执行代码精简

精简任务的交付物是实际源代码补丁：减少重复实现、保留所需契约，并通过项目验收。普通 `check` 只报告新增或加重的重复；已有克隆即使仍在，check 也可能 pass。因此新增 `simplify` 执行入口，直接处理一个选定的已有重复函数体，单独记录实际代码减少量。

## 第一版范围

同一模块文件中的两个具名顶层普通函数，参数声明、返回类型注解及函数体源码必须一致。agent 选择保留的实现与被替换的重复体，工具把后者改成 `return retained(parameters)`，保留两个函数声明及原公开入口。重复的校验、过滤或编码逻辑由一个实现负责；兼容入口可以保留，不能把入口数量当作实现数量。

本轮不依据相似度自动合并业务职责。跨文件、箭头函数、方法、脚本全局、重载、泛型、类型谓词、async/generator、默认/rest/解构/this 参数，以及涉及 this、arguments、new.target、递归、自引用、指令、eval 或选定绑定写入的情况会被拒绝。源码格式或注释差异也可能不符合本轮的精确匹配。超出范围时由 agent 按正常编辑流程完成重构，不能绕过限制声称自动精简。

参数转发前检查同名遮蔽，包括 Unicode 转义；不通过简单去空格或去注释比较函数体，避免把正则/模板中的有效空白抹掉。body 委托会改变函数源码、堆栈及耗时；这些可观察差异也应由任务契约与验收决定是否允许。自动检查与测试覆盖不等于一般语义等价证明。

带标签的模板字符串也拒绝自动委托：每个模板位置有独立缓存的模板对象，合并会影响按对象身份缓存的 tag。普通未带标签的模板字符串仍可使用；回归同时验证原生运行时的身份差异，以及无插值/有插值 tag 在预览和 apply 前均被拒绝，源码保持不变。

## 使用与结果

1. `begin --task <实际精简需求> --query <函数名>` 建立当前工作区基线，读取两个候选的源码、契约与消费者。
2. `simplify --run <id> --candidate <重复体候选ID> --into <保留实现候选ID> --json` 返回精确 edit、源码前后哈希及规模变化。此调用不写源码、不执行验收，返回 needs-review / 2、applied:false、simplificationVerified:false。
3. 用既有 `decide` 保存 modify/refactor 和两个接受的候选，再执行同一 simplify 命令并加 `--apply --summary`。不需要用户逐步确认正常源码修改，选择和执行由获得任务授权的 agent 完成。
4. apply 在覆盖、配置、源码与决策校验后写入改动，调用既有完整 check，每个配置验证照常执行。只在实际改写保留、完整检查通过、源码字节和非 trivia token 均减少时返回 simplificationVerified:true。该标记只对应当前选定编辑，不表示整个项目的所有重复都已消除。

项目 Skill 使用原有启动器，例如 `node .agents/skills/terse/scripts/run.mjs simplify ...`。apply 已完成全套验证，无需对未变化代码立即重复运行 check。函数声明仍保留时不虚构 `decision.remove`；手动退役文件/声明仍遵守删除声明约束。既有项目更新 CLI 后须显式对比并整理旧 Skill，init 继续保护自定义指令，不强行覆盖。

拒绝条件通过现有 error/diagnostics 结构返回，causeCode 为 SIMPLIFY_*，不写源码。执行后的业务验收失败返回 fail / 1；验证启动失败、超时或工作区变化返回 incomplete / 3；其他待评估发现仍为 needs-review / 2。失败不会被代码减少量覆盖，也不会静默回滚用户或验证器的改动。agent 应保留同一基线，修正补丁后完整复验，交付时披露未完成事项。

apply 先保存可核对的计划，再用临时文件替换源码，保留 UTF-8 BOM 和源文件模式。哈希与规模统计沿用快照的解码源码，BOM 不计入规模；替换前另核对原始字节，避免编码标记变化被覆盖。记录位于 `.terse/runs/<id>/simplification.json`，包含 plan、applied、simplificationVerified 和完整 report；原 check 的 report.json 与格式保持不变。`--summary` 仅缩短 CLI 中嵌套 report 的验证日志，落盘记录保留日志。该记录是本地工作证据，不是受信任的 CI 证明。

## 验收示例：先精简，再增加需求

运行 `npm run demo:simplify`。示例复用现有订单项目、付款筛选任务、真实 CLI 和 Skill 启动器，不调用模型。

第一阶段从包含两份导出函数体的项目开始。工具实际执行委托改写，保留 exportOrders 和 exportLegacyOrders 两个公开契约；权限、CSV 转义、金额异常、默认行为、输入不变性及函数 name/length 的验收和严格 TypeScript 检查通过。本机一次运行的业务源文件从 319 个非 trivia token 减至 199 个，移除 120 个 token；非空行 32 → 21，UTF-8 源码字节 1368 → 909。token 通过 TypeScript 解析后的子 token 计数，排除注释/JSDoc 与 EOF，保留模板和正则的词法上下文。字节与行数受换行形式影响，不作为跨平台固定阈值。

第二阶段的两个隔离项目从同一份已精简源码和同一验收开始增加付款状态筛选。修改原实现的版本仍只有一个导出实现体，本机新增 17 个 token / 70 字节；构造的复制版本新增 171 个 token / 688 字节并重新出现两个实现体。两者均通过相同业务和严格类型验收，复制版本被报告新增重复。完成新需求后的实际版本仍比第一阶段起点少 103 个 token / 389 字节；comparison.json 同时保留两组补丁所在项目。

这是一次可执行变换与人工编写新需求变体的受控验证，不能宣传为普通真实 agent 会话的自动精简率或相对收益。源文件、计划、阶段报告和 comparison.json 留在 `.terse/simplify-demo-*` 供复核。历史 benchmarks、归档、哈希与旧观测不改写。
