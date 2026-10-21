import { statusLabels } from '../shared/workspace.ts';
export const statusNames: Record<string, string> = {
  ...statusLabels,
  pending: '待执行',
  passed: '通过',
};
export const engineNames = {
  playwright: 'Playwright',
  'tester-army': 'TesterArmy',
  midscene: 'Midscene',
};
export const kindNames = {
  smoke: '页面可用性',
  navigation: '导航验证',
  form: '表单校验',
  visual: '视觉流程',
};
export const actionNames = {
  goto: '打开页面',
  assertPage: '检查页面可用',
  assertText: '检查可见文本',
  assertUrl: '检查当前地址',
  assertLink: '检查链接入口',
  navigateLink: '点击导航链接',
  validateForm: '检查表单必填项',
  click: '点击元素',
  fill: '填写输入框',
  aiAct: '视觉操作',
  aiAssert: '视觉断言',
};
