# Host-local deployment

This document separates the persistent development target from the unrelated
staging service. Normal development uses `dsh-dev.service`; the staging
procedure is an explicit operator action.

## Normal development: persistent `dsh-dev`

The repository's default Host acceptance target is the existing installation:

| Item           | Persistent development target                                   |
| -------------- | --------------------------------------------------------------- |
| Service        | `dsh-dev.service`                                               |
| DSH executable | `/home/neil/.local/share/dsh-dev-runtime/node_modules/.bin/dsh` |
| `DSH_HOME`     | `/home/neil/.local/state/dsh-dev`                               |
| Profile        | `web`                                                           |
| HTTP           | `http://127.0.0.1:3081/`                                        |

After focused checks, build and deploy the affected public package(s):

```sh
cd /home/neil/code/projects/lamplitisles/dsh-plugins
pnpm run dev:deploy -- @lamplitisles/dsh-nanocodex
```

Pass more than one package name when a change spans plugins. Use `--all` only
when every public plugin already installed in the persistent `web` profile is
affected. The command builds and packs those plugin artifacts before stopping
the service, stores the artifacts under the existing dev runtime's artifact
directory, updates only those existing profile dependencies, retains a
restricted profile backup, restarts only `dsh-dev.service`, and waits for the
bounded unauthenticated HTTP 401 readiness response.

The script reuses the installed DSH runtime, persistent home, profile, settings,
credentials, sessions, and unrelated dependencies. It does not run `pnpm
install` in a new DSH location, create a profile, reinstall DSH, touch
`dsh.service`, or create a disposable Host. A successful HTTP check proves only
that the service is serving; use the task-scoped browser acceptance workflow
for client and behavior checks.

If the post-stop installation or readiness check fails, the script leaves
`dsh-dev.service` stopped, prints only non-secret artifact and backup paths,
and retains the profile backup for reconciliation. Inspect the service journal
and reconcile the profile through the same DSH executable before starting it
again. Never print launch tokens or stored credentials.

The script is bound to the target table above. `DSH_CLI`, `DSH_HOME`, and
`DSH_RUNTIME` may be present in the environment only when they resolve to those
exact paths; an inconsistent override fails before build or service mutation.
The install child also receives the selected `DSH_HOME`, so an inherited
staging environment cannot redirect the update.

## Separate staging deployment

The current staging target is `/home/neil/.local/state/dsh`, served by
`dsh.service` on port 3080. It is not the development target and is not touched
by `dev:deploy`. Use the following procedure only after an explicit staging
request. It keeps settings and credentials in the staging state directory,
preserves unrelated profile dependencies, and retains a restricted backup.

Build before stopping staging:

```sh
cd /home/neil/code/projects/lamplitisles/dsh-plugins
pnpm install --frozen-lockfile
pnpm run build
```

Then update selected staging package artifacts through DSH's package manager.
The installed packages are copied directories, not checkout links; do not use
`link:` inputs or require `readlink` to resolve them into this checkout.

```sh
(
set -e
export DSH_HOME=/home/neil/.local/state/dsh
DSH_CLI=/home/neil/.local/share/dsh-runtime/node_modules/.bin/dsh
ARTIFACT_DIR=/absolute/path/to/packed-staging-artifacts
backup=$(mktemp -d /home/neil/.local/state/dsh-profile-backup-XXXXXXXX)
systemctl --user stop dsh.service
trap 'systemctl --user stop dsh.service' EXIT
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml cordis.yml; do
  cp -p "$DSH_HOME/profiles/web/$file" "$backup/$file"
  chmod 600 "$backup/$file"
done
"$DSH_CLI" plugin --profile web add \
  "$ARTIFACT_DIR/dsh-companion.tgz" \
  "$ARTIFACT_DIR/dsh-mail.tgz" \
  "$ARTIFACT_DIR/dsh-speech.tgz" \
  "$ARTIFACT_DIR/dsh-hindsight.tgz" \
  "$ARTIFACT_DIR/dsh-imagegen.tgz" \
  "$ARTIFACT_DIR/dsh-tabletop.tgz"
systemctl --user restart dsh.service
for attempt in $(seq 1 30); do
  status=$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' http://127.0.0.1:3080/ || true)
  if systemctl --user is-active --quiet dsh.service && [ "$status" = 401 ]; then break; fi
  if [ "$attempt" = 30 ]; then exit 1; fi
  sleep 1
done
for package in companion mail speech hindsight imagegen tabletop; do
  package_dir="$DSH_HOME/profiles/web/node_modules/@lamplitisles/dsh-$package"
  test -f "$package_dir/package.json"
  test ! -L "$package_dir"
done
trap - EXIT
printf 'Profile backup retained: %s\n' "$backup"
)
```

HTTP 401 is the expected unauthenticated boundary, not proof of client health.
Finish an explicitly authorized staging update with a new authenticated browser
session. Confirm the six settings contributions load without Loader errors and
preserved settings remain visible. Tabletop has no settings or client
contribution; verify its `roll_dice` tool with `{ "sides": 6 }`. Never print
launch tokens or stored credentials, send mail or Matrix messages, invoke paid
generation, or modify Hindsight memory for verification.

If a staging command or cold-client check fails, keep `dsh.service` stopped
while investigating. Retain the backup and reconcile the profile through the
DSH package manager before restarting. A successful merge alone is not
deployment.
