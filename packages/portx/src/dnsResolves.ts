import { promisify } from 'util';
import { resolve4 } from 'dns';

const resolve4Async = promisify(resolve4);

export async function dnsResolves(domain: string): Promise<string[]> {
  try {
    const addresses = await resolve4Async(domain);
    return addresses;
  } catch (error) {
    return [];
  }
}