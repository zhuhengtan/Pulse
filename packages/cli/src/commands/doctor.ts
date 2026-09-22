import { createLocalHost, type LocalHostOptions } from '@hunterzhu/pulse-server';
import chalk from 'chalk';
import { theme } from '../theme.js';

export async function runDoctor(
  options: LocalHostOptions,
  live = false,
  format = 'text'
): Promise<number> {
  const host = createLocalHost(options);
  try {
    const result = await host.doctor({ live });

    if (format === 'json' || format === 'jsonl') {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    }

    process.stdout.write(
      `${result.ok ? chalk.hex(theme.success)('● 诊断通过') : chalk.hex(theme.error)('● 发现问题')}\n`
    );
    process.stdout.write(`工作区:     ${chalk.hex(theme.accent)(result.cwd)}\n`);
    process.stdout.write(`数据目录:   ${chalk.hex(theme.dim)(result.dataDir)}\n`);
    process.stdout.write(`Node 版本:  ${result.node}\n`);
    process.stdout.write(`Provider:   ${chalk.hex(theme.primary)(result.provider)}\n`);
    process.stdout.write(`可用工具:   ${result.tools.map((t) => chalk.hex(theme.tool)(t)).join(', ')}\n`);

    if (result.live) {
      process.stdout.write(
        `实时连接:   ${result.live.ok ? chalk.hex(theme.success)('✓ 成功') : chalk.hex(theme.error)(`✗ 失败 (${result.live.message})`)}\n`
      );
    }

    if (result.errors.length > 0) {
      process.stdout.write(`\n${chalk.hex(theme.error)('错误详情:')}\n`);
      for (const err of result.errors) {
        process.stdout.write(`  ✗ ${err}\n`);
      }
    }

    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${chalk.hex(theme.error)('诊断执行失败:')} ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await host.close();
  }
}
