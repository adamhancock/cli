export interface Host {
  name?: string;
  host: string;
  port: number;
  env?: string;
}

export interface HostCheckOptions {
  host: string;
  name: string;
  port: number;
  status: boolean | string;
}

export interface ProgramOptions {
  env?: string;
  file?: string;
  host?: string;
  status?: boolean | string;
  version?: boolean;
}