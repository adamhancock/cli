import { readFileSync } from 'fs';
import { join } from 'path';

export function checkVersion(): void {
  const packagePath = join(__dirname, '../package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  console.log(packageJson.version);
}