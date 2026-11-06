import {cases} from './evaluation-cases.mjs';

// Task prompts contain business requirements and scope only; setup is installed
// by init before a fresh session. No command, candidate or run is supplied.
const requirements = {
  modify: '下载订单时支持只导出已付款订单：downloadOrders 的可选 paid 参数应生效；省略参数时保留全部可见订单。保持 owner 隔离、金额校验、CSV 转义和输入不变。',
  delete: '退役 src/legacy.ts，将订单下载调用迁移到当前导出实现，删除旧文件，保持现有导出接口和 CSV 行为。',
  refactor: '将订单 CSV 的实现移到 src/reporting.ts，保留 orders.ts 的公开导出兼容入口和下载行为，保持原有权限、金额校验和 CSV 格式。',
};
export const skillCases = Object.entries(requirements).map(([id, requirement]) => {
  const existing = cases.find(item => item.id === id);
  return {id, setup: existing.setup, acceptance: `examples/evaluation/${id}.test.mjs`,
    remove: existing.remove ?? [], candidate: existing.candidate,
    prompt: `${requirement}\n源码修改限于 src/；保留现有测试、依赖和项目配置，可阅读测试。不要提交或推送。完成后说明修改和验证结果。`};
});
