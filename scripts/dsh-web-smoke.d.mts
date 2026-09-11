import type { ChildProcess } from "node:child_process";

export const DSH_RC_VERSION: "0.1.2-rc.1";

export interface DshInvocation {
  command: string;
  args: string[];
}

export interface RuntimeProcess {
  child: ChildProcess;
  baseUrl: string;
  launchUrl: string;
}

export function dshInvocation(entry: string): DshInvocation;
export function isolatedEnvironment(
  temp: string,
  dshHome: string,
  parent?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function linkDshDependencies(
  directory: string,
  entry: string,
  invocation?: DshInvocation,
): Promise<void>;
export function startRuntime(
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RuntimeProcess>;
export function stopRuntime(runtime: RuntimeProcess | undefined): Promise<void>;
export function authenticateRuntime(runtime: RuntimeProcess): Promise<string>;
export function loadServedClient(
  runtime: RuntimeProcess,
  packageId: string,
  cookie: string,
): Promise<{
  code: string;
  registration: { id?: string; factory?: unknown };
  entry: { id?: string; url?: string };
}>;
export function jsonRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  cookie: string,
): Promise<{ response: Response; value: unknown }>;
