# Host-local deployment

Use this procedure only when deployment is requested for the local DSH `web`
profile. The target is `/home/neil/.local/state/dsh`, served by the user
`dsh.service`. A complete deployment links all seven plugins to this checkout.
Settings and credentials remain in DSH's state directory; ordinary updates do not rewrite them.

Build before stopping the service:

```sh
cd /home/neil/code/projects/lamplitisles/dsh-plugins
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

After a successful build, update the seven links through DSH's package manager.
The subshell stops the service on a failed post-stop command. It preserves
unrelated profile dependencies and retains a restricted backup of profile files.

```sh
(
set -e
REPO=/home/neil/code/projects/lamplitisles/dsh-plugins
export DSH_HOME=/home/neil/.local/state/dsh
DSH_CLI=/home/neil/.local/share/dsh-runtime/node_modules/.bin/dsh
backup=$(mktemp -d /home/neil/.local/state/dsh-profile-backup-XXXXXXXX)
systemctl --user stop dsh.service
trap 'systemctl --user stop dsh.service' EXIT
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml cordis.yml; do
  cp -p "$DSH_HOME/profiles/web/$file" "$backup/$file"
  chmod 600 "$backup/$file"
done
"$DSH_CLI" plugin --profile web add \
  "link:$REPO/packages/dsh-companion" \
  "link:$REPO/packages/dsh-mail" \
  "link:$REPO/packages/dsh-matrix" \
  "link:$REPO/packages/dsh-speech" \
  "link:$REPO/packages/dsh-hindsight" \
  "link:$REPO/packages/dsh-imagegen" \
  "link:$REPO/packages/dsh-tabletop"
systemctl --user restart dsh.service
for attempt in $(seq 1 30); do
  status=$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' http://127.0.0.1:3080/ || true)
  if systemctl --user is-active --quiet dsh.service && [ "$status" = 401 ]; then break; fi
  if [ "$attempt" = 30 ]; then exit 1; fi
  sleep 1
done
for package in companion mail matrix speech hindsight imagegen tabletop; do
  test "$(readlink -f "$DSH_HOME/profiles/web/node_modules/@lamplitisles/dsh-$package")" = "$REPO/packages/dsh-$package"
done
trap - EXIT
printf 'Profile backup retained: %s\n' "$backup"
)
```

HTTP 401 is the expected unauthenticated boundary, not proof of client health.
Finish with a new authenticated browser session: confirm all six plugin settings
contributions load without Loader errors and the preserved settings are visible.
Tabletop has no settings or client contribution; verify its `roll_dice` tool
with `{ "sides": 6 }` and confirm the result contains one die and its total.
Never print launch tokens or stored credentials. Do not send mail or Matrix
messages, invoke paid generation, or modify Hindsight memory for verification.

If a command or cold-client verification fails, keep the service stopped while
investigating. Retain the backup and reconcile the profile through the DSH
package manager before restarting. A successful merge alone is not deployment.
