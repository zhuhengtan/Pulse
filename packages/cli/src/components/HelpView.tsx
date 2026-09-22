import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const COMMANDS = [
  {
    category: 'General',
    commands: [
      { name: '/help', desc: '显示帮助信息' },
      { name: '/status', desc: '查看会话状态' },
      { name: '/tools', desc: '列出可用工具' },
      { name: '/artifacts', desc: '查看当前产物列表' },
      { name: '/exit, /quit', desc: '退出 CLI' },
      { name: '/cancel, /stop', desc: '取消当前运行并保留会话' },
    ],
  },
  {
    category: 'Session',
    commands: [
      { name: '/new', desc: '新建会话' },
      { name: '/sessions', desc: '交互式历史会话管理' },
      { name: '/delete [id]', desc: '删除指定历史会话' },
      { name: '/export [format]', desc: '导出会话 (markdown / json)' },
      { name: '/clear', desc: '清屏当前消息' },
    ],
  },
  {
    category: 'Display',
    commands: [
      { name: '/verbose, /quiet', desc: '切换输出详细程度' },
    ],
  },
  {
    category: 'Model & Context',
    commands: [
      { name: '/model [name]', desc: '切换模型' },
      { name: '/thinking [level]', desc: '设置模型思考深度 (low/medium/high/off)' },
      { name: '/compact', desc: '用已配置模型压缩历史，并备份原记录' },
      { name: '/config', desc: '查看当前运行时配置' },
    ],
  },
];

export function HelpView() {
  return (
    <Box flexDirection="column" marginY={1}>
      {COMMANDS.map((section, idx) => (
        <Box key={idx} flexDirection="column" marginBottom={1}>
          <Text color={theme.primary} bold>
            {section.category}
          </Text>
          {section.commands.map((cmd, cIdx) => (
            <Box key={cIdx}>
              <Box width={28}>
                <Text color={theme.accent}>{cmd.name}</Text>
              </Box>
              <Text>{cmd.desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
