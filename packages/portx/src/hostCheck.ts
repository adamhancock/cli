import chalk from 'chalk';
import isPortReachable from 'is-port-reachable';
import { httpCheck } from './httpCheck.js';
import { HostCheckOptions } from './types.js';

export async function hostCheck(options: HostCheckOptions): Promise<string> {
  const isReachable = await isPortReachable(options.port, {
    host: options.host
  });

  if (isReachable) {
    const message = `* SUCCESS - ${options.name} - ${options.host}:${options.port} is accessible.`;

    if (options.status) {
      return chalk.green(await httpCheck(options, message));
    } else {
      return chalk.green(message);
    }
  } else {
    return chalk.red(`* FAIL - ${options.name} - ${options.host}:${options.port} is inaccessible.`);
  }
}