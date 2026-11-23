# Go 源码分析

UTF-8 `.go` 源码自动进入新 run 的快照。使用 `begin --query` 或 `context` 查找已有实现，用 `decide` 选择候选，编辑后运行 `check`。Go 可以与 JS/TS、Python 共存于同一仓库。旧 run 沿用创建时的语言范围，使用 Go 分析时新建 run。

- 索引普通及泛型函数、接收者方法、包级类型、变量和常量。类型包含结构体、接口和别名，方法以 `Store.Save` 这类名称返回。相关测试提示使用 `_test.go` 文件名和源码文本。
- 增量重复检测保留标识符、字面量和语句边界。忽略注释和普通格式空白，区分 Go 自动插入分号的语句边界与表达式中的换行。新增或扩大的重复复用 `minTokens`、`minLines` 和 `duplicatePolicy`。[Go 语言规范](https://go.dev/ref/spec#Semicolons)
- 静态分析在 Node 中使用 WebAssembly 语法树。解析错误返回文件、行和列。当前语法库可能将省略最后一个分号的单行分组声明标为未完成，例如 `const (a = 1; b = 2)`。可用 `gofmt` 展开后重查。编译和验证使用项目自己的 Go 工具链。[Tree-sitter Go](https://github.com/tree-sitter/tree-sitter-go)
- Go 首版覆盖检索与精确重复。构建标签和包导入关系由项目工具处理。删除文件或已索引声明时，记录 `decision.remove` 并人工核对引用。自动源码改写及相似实现规则的范围仍为 JS/TS。

从 Terse 源码仓库运行 `npm run demo:go`。示例需要 Go 1.22 或更新版本，默认使用 PATH 中的 `go`，也可用 `TERSE_GO` 指定可执行文件。两种实现都接受同一套 `go test` 验收。复制版检出 1 组新增重复并返回 `needs-review`，复用原格式化函数的版本通过且新增重复为 0。比较结果和报告保存在 `.terse/demo-go-*`。
