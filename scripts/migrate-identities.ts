import { copyFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, isMap, parseDocument, type YAMLMap } from "yaml";

export const DEFAULT_DSH_HOME = "/home/neil/.local/state/dsh";
export const DEFAULT_PROFILE = "web";

const OLD_SETTINGS = {
  speech: "kepos-speech",
  hindsight: "kepos-hindsight",
} as const;

const NEW_SETTINGS = {
  speech: "dsh-speech",
  hindsight: "dsh-hindsight",
} as const;

const OLD_CREDENTIALS = {
  dashscope: "KEPOS_SPEECH_DASHSCOPE_API_KEY",
  volcengine: "KEPOS_SPEECH_VOLCENGINE_API_KEY",
} as const;

const NEW_CREDENTIALS = {
  dashscope: "DSH_SPEECH_DASHSCOPE_API_KEY",
  volcengine: "DSH_SPEECH_VOLCENGINE_API_KEY",
} as const;

const PROFILE_TARGETS = [
  { oldName: "@lamplitisles/kepos-speech", name: "@lamplitisles/dsh-speech", directory: "dsh-speech" },
  { oldName: "@lamplitisles/kepos-hindsight", name: "@lamplitisles/dsh-hindsight", directory: "dsh-hindsight" },
  { oldName: undefined, name: "@lamplitisles/dsh-matrix", directory: "dsh-matrix" },
  { oldName: undefined, name: "@lamplitisles/dsh-companion", directory: "dsh-companion" },
  { oldName: undefined, name: "@lamplitisles/dsh-imagegen", directory: "dsh-imagegen" },
] as const;

type JsonRecord = Record<string, unknown>;

export interface MigrationOptions {
  dshHome: string;
  profile?: string;
  settingsPath?: string;
  credentialsPath?: string;
  profilePackagePath?: string;
}

export interface MigrationFilePlan {
  path: string;
  exists: boolean;
  mode?: number;
  changed: boolean;
  actions: string[];
}

export interface ProfileReconciliationPlan {
  path: string;
  exists: boolean;
  removeDependencies: string[];
  linkPackages: string[];
  removeBundles: string[];
  preservedBundles: string[];
}

export interface MigrationPlan {
  dshHome: string;
  profile: string;
  files: MigrationFilePlan[];
  profileReconciliation: ProfileReconciliationPlan;
}

export interface MigrationResult extends MigrationPlan {
  applied: boolean;
  backupDirectory?: string;
  changedFiles: string[];
}

interface InternalFilePlan extends MigrationFilePlan {
  original?: string;
  output?: string;
}

interface InternalPlan extends MigrationPlan {
  internalFiles: InternalFilePlan[];
}

interface FileInput {
  path: string;
  text?: string;
  mode?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function describeYamlErrors(document: Document): string {
  return document.errors.map((error) => {
    const candidate = error as unknown as {
      code?: unknown;
      linePos?: Array<{ line?: unknown; col?: unknown }>;
    };
    const position = candidate.linePos?.[0];
    const line = typeof position?.line === "number" ? `:${position.line}` : "";
    const column = typeof position?.col === "number" ? `:${position.col}` : "";
    return `${typeof candidate.code === "string" ? candidate.code : "parse-error"}${line}${column}`;
  }).join(", ");
}

function parseYaml(text: string, path: string): { document: Document; root: JsonRecord } {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML in ${basename(path)} (${describeYamlErrors(document)})`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`${basename(path)} must contain a mapping`);
  }
  let root: unknown;
  try {
    root = document.toJS() ?? {};
  } catch {
    throw new Error(`could not read the YAML structure in ${basename(path)}`);
  }
  if (!isRecord(root)) throw new Error(`${basename(path)} must contain a mapping`);
  return { document, root };
}

function sectionNode(document: Document, key: string, path: string): YAMLMap {
  const node = document.get(key, true);
  if (!isMap(node)) throw new Error(`${basename(path)} section ${key} must contain a mapping`);
  return node;
}

function validateProvider(value: unknown, source: string): void {
  if (value !== undefined && value !== "alibaba" && value !== "bytedance") {
    throw new Error(`${source} has an unsupported Speech provider`);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
}

function migrateSpeech(document: Document, root: JsonRecord, path: string): string[] {
  const newValue = root[NEW_SETTINGS.speech];
  if (newValue !== undefined && !isRecord(newValue)) {
    throw new Error(`${basename(path)} section ${NEW_SETTINGS.speech} must contain a mapping`);
  }
  validateProvider(isRecord(newValue) ? newValue.provider : undefined, `Target ${NEW_SETTINGS.speech}`);
  if (isRecord(newValue) && hasOwn(newValue, "voice")) {
    throw new Error(`Target ${NEW_SETTINGS.speech} contains unsupported legacy voice; move it to a provider-specific voice key first`);
  }

  const oldValue = root[OLD_SETTINGS.speech];
  if (oldValue === undefined) return [];
  if (!isRecord(oldValue)) throw new Error(`${basename(path)} section ${OLD_SETTINGS.speech} must contain a mapping`);

  validateProvider(oldValue.provider, `Legacy ${OLD_SETTINGS.speech}`);
  if (oldValue.voice !== undefined && typeof oldValue.voice !== "string") {
    throw new Error(`Legacy ${OLD_SETTINGS.speech} voice is not a string`);
  }

  const provider = isRecord(newValue) && newValue.provider !== undefined
    ? newValue.provider
    : oldValue.provider ?? "alibaba";
  const providerVoice = provider === "bytedance" ? "bytedanceVoice" : "alibabaVoice";
  const oldNode = sectionNode(document, OLD_SETTINGS.speech, path);
  const actions = [`rename settings namespace ${OLD_SETTINGS.speech} -> ${NEW_SETTINGS.speech}`];

  if (newValue === undefined) {
    if (oldValue.voice !== undefined) {
      if (hasOwn(oldValue, providerVoice) && !deepEqual(oldValue[providerVoice], oldValue.voice)) {
        throw new Error(`conflicting Speech voice in ${providerVoice}; resolve the legacy and provider-specific values first`);
      }
      if (!hasOwn(oldValue, providerVoice)) {
        const voiceNode = oldNode.get("voice", true);
        oldNode.set(providerVoice, voiceNode);
      }
      oldNode.delete("voice");
      actions.push(`map legacy voice to active ${providerVoice}`);
    }
    document.set(NEW_SETTINGS.speech, oldNode);
    document.delete(OLD_SETTINGS.speech);
    return actions;
  }

  const newNode = sectionNode(document, NEW_SETTINGS.speech, path);
  const pending: Array<{ key: string; node: unknown }> = [];
  if (oldValue.voice !== undefined && hasOwn(oldValue, providerVoice) && !deepEqual(oldValue[providerVoice], oldValue.voice)) {
    throw new Error(`conflicting Speech voice in ${providerVoice}; resolve the legacy and provider-specific values first`);
  }
  for (const [key, value] of Object.entries(oldValue)) {
    if (key === "voice") continue;
    if (hasOwn(newValue, key)) {
      if (!deepEqual(newValue[key], value)) {
        throw new Error(`conflicting Speech settings at ${key}; resolve the old and new namespaces first`);
      }
    } else {
      pending.push({ key, node: oldNode.get(key, true) });
    }
  }
  if (oldValue.voice !== undefined) {
    if (hasOwn(newValue, providerVoice)) {
      if (!deepEqual(newValue[providerVoice], oldValue.voice)) {
        throw new Error(`conflicting Speech voice in ${providerVoice}; resolve the old and new namespaces first`);
      }
    } else if (!hasOwn(oldValue, providerVoice)) {
      pending.push({ key: providerVoice, node: oldNode.get("voice", true) });
      actions.push(`map legacy voice to active ${providerVoice}`);
    } else {
      actions.push(`preserve existing active ${providerVoice}`);
    }
  }
  for (const entry of pending) newNode.set(entry.key, entry.node);
  document.delete(OLD_SETTINGS.speech);
  return actions;
}

function migrateHindsight(document: Document, root: JsonRecord, path: string): string[] {
  const oldValue = root[OLD_SETTINGS.hindsight];
  if (oldValue === undefined) return [];
  if (!isRecord(oldValue)) throw new Error(`${basename(path)} section ${OLD_SETTINGS.hindsight} must contain a mapping`);
  const newValue = root[NEW_SETTINGS.hindsight];
  if (newValue !== undefined && !deepEqual(oldValue, newValue)) {
    throw new Error("conflicting Hindsight settings; resolve the old and new namespaces first");
  }
  if (newValue === undefined) {
    const oldNode = sectionNode(document, OLD_SETTINGS.hindsight, path);
    document.set(NEW_SETTINGS.hindsight, oldNode);
  }
  document.delete(OLD_SETTINGS.hindsight);
  return [`rename settings namespace ${OLD_SETTINGS.hindsight} -> ${NEW_SETTINGS.hindsight}`];
}

function migrateSettings(input: FileInput): InternalFilePlan {
  if (input.text === undefined) {
    return { path: input.path, exists: false, changed: false, actions: [] };
  }
  const { document, root } = parseYaml(input.text, input.path);
  const actions = [
    ...migrateSpeech(document, root, input.path),
    ...migrateHindsight(document, root, input.path),
  ];
  return {
    path: input.path,
    exists: true,
    mode: input.mode,
    changed: actions.length > 0,
    actions,
    original: input.text,
    output: actions.length > 0 ? document.toString() : input.text,
  };
}

function migrateCredentials(input: FileInput): InternalFilePlan {
  if (input.text === undefined) {
    return { path: input.path, exists: false, changed: false, actions: [] };
  }
  const { document, root } = parseYaml(input.text, input.path);
  const refs = root.refs;
  if (refs !== undefined && !isRecord(refs)) throw new Error(`${basename(input.path)} refs must contain a mapping`);
  const actions: string[] = [];
  const pending: Array<{ oldKey: string; newKey: string; value: unknown }> = [];
  for (const [label, oldKey, newKey] of [
    ["DashScope", OLD_CREDENTIALS.dashscope, NEW_CREDENTIALS.dashscope],
    ["Volcengine", OLD_CREDENTIALS.volcengine, NEW_CREDENTIALS.volcengine],
  ] as const) {
    if (!isRecord(refs) || !hasOwn(refs, oldKey)) continue;
    if (hasOwn(refs, newKey) && !Object.is(refs[newKey], refs[oldKey])) {
      throw new Error(`conflicting ${label} credential references; resolve the old and new keys first`);
    }
    pending.push({ oldKey, newKey, value: refs[oldKey] });
    actions.push(`rename credential reference ${oldKey} -> ${newKey}`);
  }
  if (pending.length > 0) {
    const refsNode = sectionNode(document, "refs", input.path);
    for (const entry of pending) {
      if (!hasOwn(refs!, entry.newKey)) refsNode.set(entry.newKey, refsNode.get(entry.oldKey, true));
    }
    for (const entry of pending) refsNode.delete(entry.oldKey);
  }
  return {
    path: input.path,
    exists: true,
    mode: input.mode,
    changed: actions.length > 0,
    actions,
    original: input.text,
    output: actions.length > 0 ? document.toString() : input.text,
  };
}

async function readInput(path: string): Promise<FileInput> {
  try {
    const [text, details] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { path, text, mode: details.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { path };
    throw new Error(`could not read ${basename(path)}`);
  }
}

function resolvedOptions(options: MigrationOptions): Required<MigrationOptions> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9._-]+$/u.test(profile)) throw new Error("profile must be a simple name");
  const dshHome = resolve(options.dshHome);
  return {
    dshHome,
    profile,
    settingsPath: resolve(options.settingsPath ?? join(dshHome, "settings.yaml")),
    credentialsPath: resolve(options.credentialsPath ?? join(dshHome, ".credentials.yaml")),
    profilePackagePath: resolve(options.profilePackagePath ?? join(dshHome, "profiles", profile, "package.json")),
  };
}

async function profilePlan(path: string): Promise<ProfileReconciliationPlan> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { path, exists: false, removeDependencies: [], linkPackages: PROFILE_TARGETS.map((target) => target.name), removeBundles: [], preservedBundles: [] };
    }
    throw new Error(`could not read ${basename(path)}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${basename(path)} is not valid JSON`);
  }
  if (!isRecord(manifest)) throw new Error(`${basename(path)} must contain a JSON object`);
  const dependencies = manifest.dependencies;
  if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`${basename(path)} dependencies must be an object`);
  const dsh = manifest.dsh;
  const profile = isRecord(dsh) ? dsh.profile : undefined;
  const bundles = isRecord(profile) ? profile.bundles : undefined;
  if (bundles !== undefined && (!Array.isArray(bundles) || !bundles.every((value) => typeof value === "string"))) {
    throw new Error(`${basename(path)} dsh.profile.bundles must be an array of names`);
  }
  const bundleNames = (bundles ?? []) as string[];
  const oldNames = new Set<string>(PROFILE_TARGETS.flatMap((target) => target.oldName === undefined ? [] : [target.oldName]));
  const targetNames = new Set<string>(PROFILE_TARGETS.map((target) => target.name));
  return {
    path,
    exists: true,
    removeDependencies: PROFILE_TARGETS.flatMap((target) => target.oldName !== undefined && isRecord(dependencies) && hasOwn(dependencies, target.oldName) ? [target.oldName] : []),
    linkPackages: PROFILE_TARGETS.map((target) => target.name),
    removeBundles: bundleNames.filter((name) => oldNames.has(name)),
    preservedBundles: bundleNames.filter((name) => !oldNames.has(name) && !targetNames.has(name)),
  };
}

async function buildInternalPlan(options: MigrationOptions): Promise<InternalPlan> {
  const resolved = resolvedOptions(options);
  const [settings, credentials] = await Promise.all([
    readInput(resolved.settingsPath),
    readInput(resolved.credentialsPath),
  ]);
  const [settingsPlan, credentialsPlan, profile] = await Promise.all([
    Promise.resolve(migrateSettings(settings)),
    Promise.resolve(migrateCredentials(credentials)),
    profilePlan(resolved.profilePackagePath),
  ]);
  const internalFiles = [settingsPlan, credentialsPlan];
  return {
    dshHome: resolved.dshHome,
    profile: resolved.profile,
    files: internalFiles.map(({ original: _original, output: _output, ...file }) => file),
    profileReconciliation: profile,
    internalFiles,
  };
}

function publicPlan(plan: InternalPlan): MigrationPlan {
  return {
    dshHome: plan.dshHome,
    profile: plan.profile,
    files: plan.files,
    profileReconciliation: plan.profileReconciliation,
  };
}

export async function buildPlan(options: MigrationOptions): Promise<MigrationPlan> {
  const plan = await buildInternalPlan(options);
  return publicPlan(plan);
}

async function makeBackup(backupDirectory: string, changed: InternalFilePlan[]): Promise<void> {
  const directory = resolve(backupDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const file of changed) {
    if (!file.exists) continue;
    const destination = join(directory, basename(file.path));
    try {
      await copyFile(file.path, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new Error(`backup already contains ${basename(file.path)}; choose a new backup directory`);
      }
      throw new Error(`could not back up ${basename(file.path)}`);
    }
  }
}

async function writeChangedFiles(changed: InternalFilePlan[]): Promise<void> {
  const staged: Array<{ temporary: string; target: string }> = [];
  try {
    for (const file of changed) {
      if (file.output === undefined || file.mode === undefined) throw new Error(`no write plan for ${basename(file.path)}`);
      const temporary = join(dirname(file.path), `.${basename(file.path)}.identity-migration-${randomUUID()}.tmp`);
      await writeFile(temporary, file.output, { encoding: "utf8", mode: file.mode });
      await chmod(temporary, file.mode);
      staged.push({ temporary, target: file.path });
    }
    for (const file of staged) await rename(file.temporary, file.target);
  } catch {
    await Promise.all(staged.map((file) => rm(file.temporary, { force: true })));
    throw new Error("could not commit the migrated configuration files");
  }
}

export async function applyMigration(options: MigrationOptions, backupDirectory: string): Promise<MigrationResult> {
  const plan = await buildInternalPlan(options);
  const summary = publicPlan(plan);
  const changed = plan.internalFiles.filter((file) => file.changed);
  if (changed.length === 0) {
    return { ...summary, applied: false, changedFiles: [] };
  }
  await makeBackup(backupDirectory, changed);
  await writeChangedFiles(changed);
  return {
    ...summary,
    applied: true,
    backupDirectory: resolve(backupDirectory),
    changedFiles: changed.map((file) => file.path),
  };
}

function usage(): never {
  throw new Error("usage: pnpm run identities:migrate -- <plan|check|apply> [--dsh-home PATH] [--profile NAME] [--backup-dir PATH]");
}

function cliOptions(argv: string[]): { mode: "plan" | "check" | "apply"; options: MigrationOptions; backupDirectory?: string } {
  const mode = argv.shift();
  if (mode !== "plan" && mode !== "check" && mode !== "apply") usage();
  const options: MigrationOptions = { dshHome: DEFAULT_DSH_HOME, profile: DEFAULT_PROFILE };
  let backupDirectory: string | undefined;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (value === undefined) usage();
    if (flag === "--dsh-home") options.dshHome = value;
    else if (flag === "--profile") options.profile = value;
    else if (flag === "--backup-dir") backupDirectory = value;
    else usage();
  }
  return { mode, options, backupDirectory };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const { mode, options, backupDirectory } = cliOptions(argv);
  if (mode === "apply") {
    if (backupDirectory === undefined) throw new Error("apply requires --backup-dir so the affected files are backed up first");
    console.log(JSON.stringify(await applyMigration(options, backupDirectory), null, 2));
    return;
  }
  console.log(JSON.stringify(await buildPlan(options), null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`identity-migration: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  });
}
