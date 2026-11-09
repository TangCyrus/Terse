# M4 词法私有方法清理

p-queue 的重构把 `PQueue.#onEvent` 提取为共享等待函数，旧方法与调用已经移除。此前 M4 将所有成员删除统一留给人工复核；现在可在限定范围内确认 ECMAScript `#` 私有方法的清理，仍执行全部配置验证。

## 如何判定

基线必须有带实现的命名类私有方法，类位于源文件顶层，且该路径/符号只匹配一个方法。当前同一文件必须有唯一同名顶层类。通过现有 `remove` 声明，例如 `{ "path": "source/index.ts", "symbol": "PQueue.#onEvent" }`，无需修改决策格式。

- 当前类仍声明该私有名，包括改成字段、访问器或 static 成员：`REMOVAL_REMAINS` / fail。
- 当前类词法范围仍有该私有名的调用、读取、绑定或品牌检查（`#name in object`）：`REMOVAL_REFERENCE_REMAINS` / fail，附当前源码行号。接收者是否能被类型推导不影响该结论。
- 方法和所有词法引用均消失，且不存在下列不确定条件：该目标不再产生清理发现。整个 check 是否 pass 仍取决于其他规则、覆盖范围与全部验证。
- 直接 `eval(...)`、装饰器、ambient 类、无法唯一对应或移动/重命名的类：`REMOVAL_REFERENCE_UNCERTAIN` / review。方法未被索引、目标未覆盖、文件整体删除等继续走既有检查，不使用此快捷结论。

字符串、注释、普通属性 `object["#name"]`、其他类的同名私有成员以及文件导入关系，不构成这个词法私有名的引用。只有此限定分支不受无关导入归属提示影响；同次删除其他文件或公共符号时，它们的残留与未解析引用继续检查。解析错误、配置错误及扫描缺口仍由完整 check 报告。

## 嵌套类与动态代码

嵌套函数继承所在的私有环境。嵌套类若没有自己的同名私有声明，其引用仍需检查；若声明了自己的同名方法、字段或访问器，只对它的成员体遮蔽外层名字。嵌套类的 `extends` 表达式在外层私有环境求值，即使类体有同名声明也必须检查。根类自身的 `extends` 不属于其新建的私有环境。依据见 ECMAScript 的 [PrivateEnvironment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-privateenvironment-records) 和 [ClassDefinitionEvaluation](https://tc39.es/ecma262/multipage/ecmascript-language-functions-and-classes.html#sec-runtime-semantics-classdefinitionevaluation)。

直接 eval 可以从运行时字符串访问当前私有环境，因此保留复核；括号及 TypeScript 类型包装不会绕过检查。间接 eval（如 `(0, eval)(code)`、`eval?.(code)`）不继承该环境。即使局部变量恰好叫 eval，也保守复核，不据此证明运行时绑定。字符串内容本身不作为静态引用解析。

本轮只证明上述词法引用范围内的旧方法已清理，不证明业务等价、无死代码或完整调用图。公共成员、TypeScript `private`、任意计算属性、外部消费者和一般反射没有获得这一保证。声明约束继续生效：观察到旧目标消失但 `decision.remove` 漏填仍 fail，不能靠新版清理推断自动补写决策。

## 验证与历史

[私有清理回归](../test/private-cleanup.test.mjs) 覆盖正反例、嵌套遮蔽、heritage、直接 eval、覆盖不足和多删除目标。原生 JavaScript 检查私有绑定语义；CLI 集成测试在同一 run 验证残留失败、清理通过与动态复核，三次均执行项目验证。既有删除声明回归继续覆盖所有 strategy 的遗漏与补填。

两个历史 p-queue Skill 批次的四份重构记录用当前代码重放；发布测试先校验原始归档、报告、审查与哈希，再单独断言当前 M4 不再产生该私有清理复核。它们来自相同重构补丁（SHA-256 `2cc71486ea1bfe1bc8177166e476afce924a68ff37e71424e6c7952164c75c48`），不能算作四种独立修复方案。

本轮另在固定 p-queue v8.0.1 提交 `47a4f19ab3d4422e06cb1b618f4c45a11b5def30` 的隔离副本逐份应用四个 hash 校验后的补丁，使用完整 input 明确声明 `PQueue.#onEvent`。四次完整 check 均 pass、无清理发现、无未声明删除；每次均执行编译、4 项任务行为、上游 AVA（45 passed / 2 known failures）及严格类型验收。这是当前代码下显式声明删除的回放；旧批次漏填声明的原始工作流不因此变为通过。当前测试总计 290 项通过，包含 40 项新增私有清理测试（含子用例）。

原始 [Skill 评测](PQUEUE-SKILL-BENCHMARK.md) 与 [删除声明复测](PQUEUE-REMOVAL-SKILL-BENCHMARK.md) 的数据、哈希和严格工作流 4/6 观测不回填。当前回放是确定性验证，不是新的真实 agent 会话，也不据此声称 agent 行为改善。
