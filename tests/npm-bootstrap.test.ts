import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const fixtures: string[] = [];

async function fixture(overrides: Record<string, unknown> = {}) {
  const temp = await mkdtemp(join(tmpdir(), "dsh-bootstrap-test-"));
  fixtures.push(temp);
  await mkdir(join(temp, "scripts"));
  await mkdir(join(temp, "packages/dsh-tabletop"), { recursive: true });
  await writeFile(join(temp, "package.json"), '{"type":"module"}\n');
  for (const file of ["npm-bootstrap.sh", "release-shared.ts"]) {
    await cp(join(root, "scripts", file), join(temp, "scripts", file));
  }
  const manifestPath = join(temp, "packages/dsh-tabletop/package.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: "@lamplitisles/dsh-tabletop",
      version: "0.1.0",
      repository: {
        type: "git",
        url: "https://github.com/LamplitIsles/dsh-plugins.git",
        directory: "packages/dsh-tabletop",
      },
      publishConfig: {
        registry: "https://registry.npmjs.org",
        access: "public",
      },
      ...overrides,
    }),
  );
  return { temp, manifestPath, script: join(temp, "scripts/npm-bootstrap.sh") };
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((temp) => rm(temp, { recursive: true, force: true })),
  );
});

it.each(["@lamplitisles/dsh-tabletop", "dsh-tabletop"])(
  "plans %s from another directory without mutating the manifest",
  async (selector) => {
    const { temp, manifestPath, script } = await fixture();
    const before = await readFile(manifestPath, "utf8");
    const plan = JSON.parse(
      execFileSync("bash", [script, "--plan", selector], {
        cwd: join(temp, "scripts"),
        encoding: "utf8",
      }),
    );
    expect(plan).toEqual({
      name: "@lamplitisles/dsh-tabletop",
      directory: "dsh-tabletop",
      manifestPath,
      currentVersion: "0.1.0",
      bootstrapVersion: "0.1.0-beta.0",
      stableVersion: "0.1.0",
    });
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  },
);

it("preserves an already selected prerelease", async () => {
  const { temp, script } = await fixture({ version: "2.3.4-rc.2" });
  const plan = JSON.parse(
    execFileSync("bash", [script, "--plan", "dsh-tabletop"], {
      cwd: temp,
      encoding: "utf8",
    }),
  );
  expect(plan).toMatchObject({
    bootstrapVersion: "2.3.4-rc.2",
    stableVersion: "2.3.4",
  });
});

it.each([
  ["@lamplitisles/dsh-plugins", {}],
  ["../../escape", {}],
  ["dsh-tabletop", { private: true }],
  ["dsh-tabletop", { version: "invalid" }],
  ["dsh-tabletop", { version: "0.1.0+build" }],
  ["dsh-tabletop", { name: "@someone/else" }],
] as const)(
  "rejects an invalid bootstrap selection: %s %j",
  async (selector, overrides) => {
    const { temp, script } = await fixture(overrides);
    const result = spawnSync("bash", [script, "--plan", selector], {
      cwd: temp,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
  },
);

it("refuses noninteractive execution before any banner or version change", async () => {
  const { temp, script, manifestPath } = await fixture();
  const before = await readFile(manifestPath, "utf8");
  const result = spawnSync("bash", [script, "dsh-tabletop"], {
    cwd: temp,
    encoding: "utf8",
    input: "",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("requires interactive stdin");
  expect(result.stdout).toBe("");
  expect(await readFile(manifestPath, "utf8")).toBe(before);
});

async function interactiveFixture() {
  const source = await fixture();
  const support = await mkdtemp(join(tmpdir(), "dsh-bootstrap-tools-"));
  fixtures.push(support);
  const bin = join(support, "bin");
  await mkdir(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const env = {
    ...process.env,
    HOME: support,
    XDG_CONFIG_HOME: support,
    npm_config_cache: join(support, "npm-cache"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: support,
    TERM: "xterm",
    PATH: `${bin}:${process.env.PATH}`,
    BOOTSTRAP_TEST_STATE: support,
    BOOTSTRAP_TEST_GIT: realGit,
    DSH_CLI: join(bin, "dsh"),
    NODE_OPTIONS: `--import=${join(support, "network-guard.mjs")}`,
  };
  await writeFile(
    join(support, "network-guard.mjs"),
    `
import { readFileSync, writeFileSync } from 'node:fs';
const state = process.env.BOOTSTRAP_TEST_STATE;
globalThis.fetch = async () => {
  const path = state + '/fetch-count';
  let count = 0;
  try { count = Number(readFileSync(path, 'utf8')); } catch {}
  writeFileSync(path, String(count + 1));
  if (count === 0) return new Response('', { status: 404 });
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};
`,
  );
  const fake = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const state = process.env.BOOTSTRAP_TEST_STATE;
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const log = (event) => appendFileSync(join(state, 'events'), JSON.stringify(event) + '\\n');
const published = join(state, 'published');
if (tool === 'git') {
  if (args[0] === 'ls-remote') { log({ tool, args }); console.log('a'.repeat(40) + '\\trefs/heads/main'); }
  else {
    const r = spawnSync(process.env.BOOTSTRAP_TEST_GIT, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
} else if (tool === 'npm') {
  log({ tool, args });
  if (args[0] === 'view') {
    if (existsSync(published) && (args[1].endsWith('@0.1.0-beta.0') || args[2] === 'versions')) {
      console.log(JSON.stringify(args[2] === 'versions' ? ['0.1.0-beta.0'] : '0.1.0-beta.0'));
    } else { console.log(JSON.stringify({ error: { code: 'E404' } })); process.exit(1); }
  } else if (args[0] === 'whoami') console.log('fixture-owner');
  else if (args[0] === 'publish') {
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', args[1], 'package.json'], { encoding: 'utf8' }));
    if (manifest.name !== '@lamplitisles/dsh-tabletop' || manifest.version !== '0.1.0-beta.0') process.exit(1);
    writeFileSync(published, JSON.stringify(manifest));
  } else process.exit(1);
} else if (tool === 'corepack') {
  log({ tool, args, cwd: process.cwd() });
  if (args.includes('--version')) console.log('12.3.4');
  if (args.includes('release:prepare')) {
    const destination = args.at(-1);
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-czf', join(destination, 'fixture.tgz'), '-C', join(process.cwd(), 'packages/dsh-tabletop'), 'package.json']);
  }
} else if (tool === 'curl') {
  log({ tool, args });
  if (process.env.BOOTSTRAP_TEST_CURL_FAIL === '1') process.exit(28);
  const body = JSON.stringify({ state: 'active', path: '.github/workflows/publish.yml' });
  const output = args.indexOf('--output');
  if (output >= 0) writeFileSync(args[output + 1], body);
  else console.log(body);
} else if (tool === 'dsh') console.log('0.1.2-rc.1');
else if (tool === 'wslview') log({ tool, args });
else process.exit(1);
`;
  for (const name of [
    "git",
    "npm",
    "corepack",
    "pnpm",
    "curl",
    "dsh",
    "wslview",
  ]) {
    await writeFile(join(bin, name), fake);
    await chmod(join(bin, name), 0o755);
  }
  const git = (...args: string[]) =>
    execFileSync(realGit, args, { cwd: source.temp, env, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Bootstrap fixture");
  git("config", "user.email", "bootstrap@example.invalid");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  return { ...source, support, env };
}

async function nodeVersionFixture(version: string) {
  const source = await fixture();
  const support = await mkdtemp(join(tmpdir(), "dsh-bootstrap-node-test-"));
  fixtures.push(support);
  const bin = join(support, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "node"),
    `#!/bin/sh
if [ "\${1:-}" = "-e" ] && case "\${2:-}" in *process.versions.node*) true ;; *) false ;; esac; then
  rewritten=$(printf '%s' "$2" | sed "s/process\\.versions\\.node/\\"$BOOTSTRAP_TEST_NODE_VERSION\\"/g")
  exec "$BOOTSTRAP_TEST_REAL_NODE" -e "$rewritten"
fi
exec "$BOOTSTRAP_TEST_REAL_NODE" "$@"
`,
  );
  await chmod(join(bin, "node"), 0o755);
  return {
    ...source,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BOOTSTRAP_TEST_NODE_VERSION: version,
      BOOTSTRAP_TEST_REAL_NODE: process.execPath,
    },
  };
}

it.each([
  ["24.10.0", false],
  ["24.11.0", true],
  ["25.0.0", true],
] as const)(
  "applies the Node.js minimum to %s without rejecting newer majors",
  async (version, accepted) => {
    const { temp, script, env } = await nodeVersionFixture(version);
    const result = spawnSync("bash", [script, "--plan", "dsh-tabletop"], {
      cwd: temp,
      env,
      encoding: "utf8",
    });
    const observed = {
      accepted: result.status === 0,
      currentVersion:
        result.status === 0 ? JSON.parse(result.stdout).currentVersion : null,
      rejectedForMinimum:
        result.status === 0
          ? false
          : result.stderr.includes("Use Node.js >=24.11.0."),
    };
    expect(observed).toEqual({
      accepted,
      currentVersion: accepted ? "0.1.0" : null,
      rejectedForMinimum: !accepted,
    });
  },
);

it("publishes only the temporary beta artifact without a pre-merge GitHub fetch", async () => {
  const { temp, support, script, manifestPath, env } =
    await interactiveFixture();
  const before = await readFile(manifestPath, "utf8");
  const result = spawnSync(
    "script",
    ["-q", "-e", "-c", `bash '${script}' dsh-tabletop`, "/dev/null"],
    {
      cwd: temp,
      env,
      encoding: "utf8",
      input: "\ny\ny\ny\ny\ny\ny\ny\n",
      timeout: 15_000,
    },
  );
  expect(result.status).toBe(0);
  expect(await readFile(manifestPath, "utf8")).toBe(before);
  const published = JSON.parse(
    await readFile(join(support, "published"), "utf8"),
  );
  expect(published.version).toBe("0.1.0-beta.0");
  const events = (await readFile(join(support, "events"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.some(
      (event) => event.tool === "git" && event.args[0] === "ls-remote",
    ),
  ).toBe(false);
  const publishIndex = events.findIndex(
    (event) => event.tool === "npm" && event.args[0] === "publish",
  );
  const workflowIndex = events.findIndex((event) => event.tool === "curl");
  expect(publishIndex).toBeGreaterThan(-1);
  expect(workflowIndex).toBeGreaterThan(publishIndex);
  const checks = events.filter(
    (event) => event.tool === "corepack" && event.args[1] !== "--version",
  );
  expect(checks.every((event) => event.cwd !== temp)).toBe(true);
  expect(checks.map((event) => event.args.join(" "))).toEqual(
    expect.arrayContaining([
      "pnpm install --frozen-lockfile",
      "pnpm run lint",
      "pnpm run format:check",
      "pnpm run typecheck",
      "pnpm run test",
      "pnpm run build",
      "pnpm run pack:check",
      "pnpm run artifact:smoke",
    ]),
  );
  expect(
    (await readdir(support)).some((name) =>
      name.startsWith("dsh-npm-bootstrap."),
    ),
  ).toBe(false);
});

it("stops on declined publication and leaves the checkout unchanged", async () => {
  const { temp, support, script, manifestPath, env } =
    await interactiveFixture();
  const before = await readFile(manifestPath, "utf8");
  const result = spawnSync(
    "script",
    ["-q", "-e", "-c", `bash '${script}' dsh-tabletop`, "/dev/null"],
    {
      cwd: temp,
      env,
      encoding: "utf8",
      input: "\ny\nn\n",
      timeout: 15_000,
    },
  );
  expect(result.status).toBe(1);
  expect(await readFile(manifestPath, "utf8")).toBe(before);
  expect(await readdir(support)).not.toContain("published");
  expect(
    (await readdir(support)).some((name) =>
      name.startsWith("dsh-npm-bootstrap."),
    ),
  ).toBe(false);
});

it("resumes setup after a workflow timeout without republishing or revalidating", async () => {
  const { temp, support, script, env } = await interactiveFixture();
  const run = (extra: Record<string, string>) =>
    spawnSync(
      "script",
      ["-q", "-e", "-c", `bash '${script}' dsh-tabletop`, "/dev/null"],
      {
        cwd: temp,
        env: { ...env, ...extra },
        encoding: "utf8",
        input: "\ny\ny\ny\ny\ny\ny\n",
        timeout: 15_000,
      },
    );
  const first = run({ BOOTSTRAP_TEST_CURL_FAIL: "1" });
  expect(first.status).toBe(1);
  expect(first.stdout + first.stderr).toContain("Bootstrap remains published");
  const second = run({});
  expect(second.status).toBe(0);
  const events = (await readFile(join(support, "events"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.filter(
      (event) => event.tool === "npm" && event.args[0] === "publish",
    ),
  ).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.tool === "corepack" &&
        event.args.join(" ") === "pnpm run typecheck",
    ),
  ).toHaveLength(1);
});
