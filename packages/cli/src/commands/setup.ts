import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { defaultPulseConfig, defaultPulseConfigPath } from '../config.js';

export async function runSetup(force: boolean, explicitPath?: string): Promise<number> {
  try {
    const configPath = explicitPath ? path.resolve(explicitPath) : defaultPulseConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    let exists = false;
    try {
      await fs.access(configPath);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists && !force) {
      console.log(chalk.yellow(`Config file already exists at ${configPath}. Use --force to overwrite.`));
      return 1;
    }

    await fs.writeFile(configPath, `${JSON.stringify(defaultPulseConfig, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(configPath, 0o600);
    console.log(chalk.green(`✓ Created config file at ${configPath}`));

    return 0;
  } catch (error) {
    console.error(chalk.red('Failed to setup config:'), error);
    return 1;
  }
}
