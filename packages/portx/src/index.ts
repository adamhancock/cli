#!/usr/bin/env node

import chalk from 'chalk';
import { dnsResolves } from './dnsResolves.js';
import { hostCheck } from './hostCheck.js';
import { isIP } from 'is-ip';
import { Command } from 'commander';
import { fileTemplating } from './fileTemplating.js';
import { ProgramOptions } from './types.js';

const program = new Command();

program
  .option('-e, --env <string>', 'environment templating')
  .option('-f, --file <string>', 'file based')
  .option('-h, --host <string>', 'host based')
  .option('-s, --status [type]', 'http status code')
  .option('-v, --version', 'Check version', false);

program.parse(process.argv);

const options = program.opts() as ProgramOptions;
const hosts = fileTemplating(options);

hosts.forEach(async (host) => {
  const env = host.env ? `${host.env.toUpperCase()} -` : '';
  const name = host.name ? ` ${host.name} - ` : '';

  if (!isIP(host.host)) {
    const ipaddresses = await dnsResolves(host.host);
    if (ipaddresses.length === 0) {
      console.log(
        chalk.red(`* FAIL - ${env}${name}${host.host} does not resolve`)
      );
    } else {
      for (const address of ipaddresses) {
        const result = await hostCheck({
          host: address,
          name: `${env}${name}${host.host}`,
          port: host.port,
          status: options.status || false,
        });
        console.log(result);
      }
    }
  } else {
    const result = await hostCheck({
      host: host.host,
      name: `${env} ${name}${host.host}`,
      port: host.port,
      status: options.status || false,
    });
    console.log(result);
  }
});