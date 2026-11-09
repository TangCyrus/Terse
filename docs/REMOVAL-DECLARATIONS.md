# 删除声明约束

本轮 M5 解决 p-queue Skill 评测中两次重构漏填 `decision.remove`、当时的 check 仍通过的问题。核心检查现在根据基线和当前源码推导漏声明目标，不依赖 agent 选择的 strategy，也不根据需求文字猜测是否删除。历史会话、4/6 工作流结论、补丁和冻结哈希原样保留。

## 声明与检查

修改前声明准备退役的基线文件或已索引声明。原地重构、修改函数体以及合理新增没有删除目标时，`remove: []` 仍然合法，decide 不会强迫所有 refactor 填写虚假删除。

- 整个源文件删除或迁移：使用 `--remove <path>`，或输入中的 `{"path":"<path>"}`。文件已经消失时，单个符号声明不代替整文件声明。
- 文件保留但方法、函数、类等已索引声明消失或更名：使用完整 `--input` 中的 `{"path":"<path>","symbol":"<基线精确名称>"}`。例如 `PQueue.#onEvent`，而不是 `#onEvent` 或新 helper 的名字。
- 退役的父声明覆盖其内部 helper，不必逐个登记随整个方法或类一起删除的局部函数。同一行的相邻声明仍分别检查；推导使用 AST 字符范围，不用行号判断包含关系。
- 声明保留整个文件的删除、但该文件仍存在时，M4 返回 `REMOVAL_REMAINS`；不能用宽泛文件声明替代有效的符号清理。

`decisionGuide.removalGuide` 给出文件和符号形状及恢复说明。符号删除沿用已有完整输入格式和 `inputArgvTemplate`，不引入另一组 CLI 标志。例如：

```json
{
  "strategy": "refactor",
  "rationale": "提取既有等待实现，公开入口委托新 helper。",
  "considered": [{
    "path": "source/index.ts",
    "symbol": "PQueue.#onEvent",
    "disposition": "modify",
    "reason": "迁移既有职责并移除原私有方法。"
  }],
  "remove": [{"path": "source/index.ts", "symbol": "PQueue.#onEvent"}]
}
```

check 在基线及当前索引分析成功后，对消失且没有跳过覆盖记录的文件，以及仍在扫描范围内、路径和名称已消失的声明，核对 `decision.remove`。无论 strategy 为 reuse、modify、refactor 还是 new，漏声明均产生 **`REMOVAL_DECLARATION_MISSING` / fail / 退出码 1**。JSON、summary 和落盘报告都包含 `undeclaredRemovals` 数组，元素可直接作为缺失目标参考，不需要解析自然语言消息。

该约束复用 `indexSources` 的同一次 AST 遍历及已有 M4 清理逻辑。推导目标也会进入引用检查，让未声明删除同时暴露已知残留调用和不确定引用；不会自动改写 decision，也不自动认可或删除源码。所有配置的验证继续执行，声明失败不能跳过测试或类型检查。

## 同一基线上的修正

读取当前完整 decision，检查 `undeclaredRemovals`，补全同一个 run 的 remove 后用 `decide --run <id> --input <file>` 保存，再运行完整 check。input 替换整份记录，须保留原 considered、理由及仍适用的 remove；丢掉另一项声明会再次失败。修改后补填可以纠正当前记录，不会证明修改前已按 Skill 声明；历史阶段证据不回填。

声明补齐只解决“未声明”这一项。残留引用仍 fail；成员访问、动态表达式等不能确认时仍 needs-review。不能通过切换 strategy、重新 begin 或仅重复未变化的验证隐藏问题。

已安装的项目在使用新版 CLI 后即可受到核心约束。新的 Skill 模板增加了修改前的符号声明及漏填后的恢复指引。init 继续保护已有文件，不自动覆盖旧版或自定义 Skill；已有项目须对比模板并显式整理 `.agents/skills/terse/SKILL.md`，保留本地修改。

## 回归与边界

[删除声明回归](../test/removal-declarations.test.mjs) 覆盖四种策略、空列表的合理场景、完整四命令执行、同一 run 修正、部分/丢失声明、残留导入、整文件与符号区分、父子折叠、同一行相邻声明、迁移、兼容转发和覆盖缺口。另将已发布的两份 p-queue 重构补丁应用于独立副本，均推导出 `source/index.ts / PQueue.#onEvent`；该离线测试不安装上游依赖、不调用模型、不重写历史数据。

本地还在独立依赖副本中执行了这两份历史记录对应的完整编译、任务验收、上游 AVA 与严格类型检查。每份补丁在空声明与补齐声明的两次 check 中，四组验证均通过（AVA 45 项通过、2 项既有预期失败）；状态分别为 fail 和保留成员引用复核的 needs-review。两份历史补丁字节相同，本次是确定性回归，不计作两个新实现或新的自主修正会话。

推导针对扫描器已经索引的声明身份，不是完整的语义删除或死代码分析。同路径同名替换或局部作用域重名不能证明删除；保留实现时减少重载签名不会机械要求 remove。访问器、类字段箭头函数、匿名实现等未索引语法不在本轮覆盖范围内。已有跳过记录不被当作确认删除，仍由覆盖/配置/解析检查决定是否未完成或需要复核。分析错误时 `undeclaredRemovals: []` 不能解释为不存在遗漏。

本轮验证的是确定性约束及恢复流程，没有新增真实 agent 会话；新版指引能否改善自主声明率仍须用新的会话评测，不能把本轮测试回写为旧会话成功。
