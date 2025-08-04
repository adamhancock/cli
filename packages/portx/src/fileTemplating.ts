import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { checkVersion } from './checkVersion.js';
import { Host, ProgramOptions } from './types.js';

export function fileTemplating(program: ProgramOptions): Host[] {
  if (program.version) {
    checkVersion();
    process.exit(0);
  }

  if (program.file === undefined && program.host === undefined) {
    console.log(chalk.red('No hosts specified.'));
    process.exit(1);
  }

  if (program.env && program.file) {
    const environments = program.env.split(',');
    const hosts: Host[] = [];
    
    environments.forEach((environment) => {
      const template = Handlebars.compile(
        readFileSync(join(process.cwd(), program.file!)).toString()
      );
      const templateResults: Host[] = JSON.parse(
        template({
          env: environment,
        })
      );
      hosts.push(
        ...templateResults.map((result) => ({
          ...result,
          env: environment,
        }))
      );
    });
    return hosts;
  } else {
    // command line hosts
    if (program.host) {
      const [host, portStr] = program.host.split(':');
      const port = parseInt(portStr, 10);
      
      if (!portStr || isNaN(port)) {
        console.log(
          chalk.red(`No port specified. Try again with portx -h ${host}:443`)
        );
        process.exit(1);
      }

      return [{
        host: host,
        port: port,
      }];
    } else if (program.file) {
      const fileContent = readFileSync(join(process.cwd(), program.file), 'utf8');
      return JSON.parse(fileContent);
    }
  }

  return [];
}