import axios from 'axios';
import chalk from 'chalk';
import { HostCheckOptions } from './types.js';

export async function httpCheck(host: HostCheckOptions, message: string): Promise<string> {
  let protocol = 'http';
  
  if (host.status === undefined || host.status === true) {
    protocol = 'http';
  } else if (typeof host.status === 'string') {
    protocol = host.status;
  }

  const hostHeader = {
    Host: host.name,
  };

  if (protocol === 'https') {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }

  try {
    const response = await axios.get(`${protocol}://${host.host}:${host.port}`, {
      headers: hostHeader,
    });
    
    return `${message} HTTP: ${response.status} ${response.statusText}`;
  } catch (error: any) {
    if (error.response) {
      return `${message} ${chalk.red(`HTTP: ${error.response.status} ${error.response.statusText}`)}`;
    } else {
      return `${message} ${chalk.red('HTTP connection error (Try with HTTP)')}`;
    }
  }
}