# Python 源码分析

Terse 支持 UTF-8 `.py` 源文件。首次任务使用 `begin --query`，在同一份基线中检索函数和类，读取候选后用 `decide` 记录选用的实现。`check` 将新增或扩大的 Python token 重复与基线比较，并执行项目配置的验证命令。Python 和 JS/TS 可以出现在同一个 Git 工作区。

- 检索覆盖普通和异步函数、类、方法及嵌套声明。候选保留范围、签名、带装饰器的片段和 `Receipt.total` 一类的限定名称。相关测试按文件名和文本提示。
- 重复检测保留标识符、字面量、语句边界和缩进形成的块边界，忽略注释和格式空白。Python 使用独立 token 格式，增量计数复用现有检测与归因逻辑。
- 解析器在 Node 中运行，不加载目标项目的 Python 模块。语法树存在解析错误时返回带路径、行和列的未完成结果。可识别的语法取决于当前语法库，编译规则（例如某些无效缩进）仍由项目的 Python 验证命令检查。[Lezer Python](https://code.haverbeke.berlin/lezer/python)
- Python 首版的自动分析范围是检索和精确重复。退役的文件或声明仍需填写 `decision.remove`，并人工检查导入和调用方。Python `.pyi`、导入解析、相似实现提示和 `simplify --apply` 由后续语言能力扩展覆盖。

旧 run 保留原有 JS/TS 扫描范围。升级后为 Python 任务新建 run，即可得到包含 `.py` 文件的基线。安装过旧 Skill 的项目可对比新版模板并显式更新项目指令。

从 Terse 源码仓库运行 `npm run demo:python`。示例为现有收据增加仅导出已付款项的功能，两种实现使用同一组 Python `unittest` 测试。复制版报告 1 组新增重复并返回 `needs-review`，调用旧格式化函数的版本返回 `pass`，新增重复为 0。比较结果和两份检查报告保存在 `.terse/demo-python-*`。示例需要 Python 3，Windows 默认寻找 `python`，其他系统默认寻找 `python3`，也可用 `TERSE_PYTHON` 指定解释器。Terse 的静态分析本身仅使用 Node。
