import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const CONFIG_DIR = join(homedir(), '.workstream-daemon');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

export interface AuthConfig {
  token: string;
}

export async function getAuthToken(): Promise<string> {
  try {
    // Try to read existing token
    const data = await readFile(AUTH_FILE, 'utf-8');
    const config = JSON.parse(data) as AuthConfig;
    if (config.token) {
      return config.token;
    }
  } catch (error) {
    // File doesn't exist or is invalid, proceed to generate new one
  }

  // Generate new token
  const token = randomUUID();
  const config: AuthConfig = { token };

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(AUTH_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Failed to save auth config:', error);
  }

  return token;
}
