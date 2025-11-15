import * as vscode from 'vscode';

export class Config {
  private static readonly SECTION = 'workstream';

  static get enabled(): boolean {
    return vscode.workspace.getConfiguration(this.SECTION).get('enabled', true);
  }

  static get redisHost(): string {
    return vscode.workspace.getConfiguration(this.SECTION).get('redis.host', 'localhost');
  }

  static get redisPort(): number {
    return vscode.workspace.getConfiguration(this.SECTION).get('redis.port', 6379);
  }

  static get heartbeatInterval(): number {
    return vscode.workspace.getConfiguration(this.SECTION).get('heartbeatInterval', 10000);
  }
}
