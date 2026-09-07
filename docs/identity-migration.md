# Local identity migration

The repository's current identities are six public packages:

`@lamplitisles/dsh-companion`, `@lamplitisles/dsh-mail`,
`@lamplitisles/dsh-matrix`, `@lamplitisles/dsh-speech`,
`@lamplitisles/dsh-hindsight`, and `@lamplitisles/dsh-imagegen`.

Imagegen's core is an internal module in `packages/dsh-imagegen`; it is not a
seventh workspace package. Speech's optional Host service is `dshSpeech`, its
RPC is `/dsh-speech`, and its workspace audio directory is
`.dsh/dsh-speech/audio`.

## Migration behavior

The root `identities:migrate` command is a one-off operator tool. It is never
run during normal plugin startup. `plan` and `check` parse the target files,
report names/types/actions only, and do not write anything:

```sh
corepack pnpm run identities:migrate -- plan \
  --dsh-home /home/neil/.local/state/dsh --profile web
```

The apply path requires an explicit backup directory. It preserves the
existing settings and credential file modes, copies each changed file into a
new restricted backup directory, then commits only the planned YAML edits:

```sh
corepack pnpm run identities:migrate -- apply \
  --dsh-home /home/neil/.local/state/dsh --profile web \
  --backup-dir /home/neil/.local/state/dsh-identity-backups/<new-directory>
```

The fixed mappings are:

| Existing key | New key |
|---|---|
| `kepos-speech` | `dsh-speech` |
| `kepos-hindsight` | `dsh-hindsight` |
| `KEPOS_SPEECH_DASHSCOPE_API_KEY` | `DSH_SPEECH_DASHSCOPE_API_KEY` |
| `KEPOS_SPEECH_VOLCENGINE_API_KEY` | `DSH_SPEECH_VOLCENGINE_API_KEY` |

The legacy Speech `voice` field is placed into `alibabaVoice` when the active
provider is Alibaba and into `bytedanceVoice` when the active provider is
ByteDance. An existing provider-specific target value is retained when it is
identical and is a conflict when it differs. Hindsight's `bankId`, provider
names, credential values, unrelated YAML entries, and comments on untouched
nodes remain unchanged. A conflicting old/new value fails before either file
is written; a second run is a no-op.

The command's profile report identifies the five packages that must be linked
to this checkout and the bundles that must remain. It does not rewrite the
profile's package manifest: use DSH's package manager so dependency links and
`dsh.profile.bundles` are reconciled by the supported path.

## Owner deployment

The Owner executes this exact sequence only after review and the approval-gated
merge. It builds first, plans before stopping the service, stops the exact
user service while the two YAML files change, keeps the backup outside this
checkout, then replaces only the five scoped profile links. No credential value
is placed in an argument or output. The command runs in a subshell with a
scoped `EXIT` cleanup: any failure after the service stops, including a failed
restart or post-restart check, stops the service before the command exits. The
trap is cleared only after the final automated check succeeds.

```sh
(
set -e

REPO=/home/neil/code/projects/lamplitisles/dsh-plugins
DSH_HOME=/home/neil/.local/state/dsh
DSH_CLI=/home/neil/.local/share/dsh-runtime/node_modules/.bin/dsh
BACKUP_DIR=/home/neil/.local/state/dsh-identity-backups/$(date -u +%Y%m%dT%H%M%SZ)

service_stopped=false
cleanup() {
  if [ "$service_stopped" = true ]; then
    systemctl --user stop dsh.service || true
  fi
}
trap cleanup EXIT

cd "$REPO"
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm run identities:migrate -- plan --dsh-home "$DSH_HOME" --profile web
systemctl --user stop dsh.service
service_stopped=true
corepack pnpm run identities:migrate -- apply --dsh-home "$DSH_HOME" --profile web --backup-dir "$BACKUP_DIR"
DSH_HOME="$DSH_HOME" "$DSH_CLI" plugin --profile web remove @lamplitisles/kepos-speech @lamplitisles/kepos-hindsight
DSH_HOME="$DSH_HOME" "$DSH_CLI" plugin --profile web add \
  "link:$REPO/packages/dsh-speech" \
  "link:$REPO/packages/dsh-hindsight" \
  "link:$REPO/packages/dsh-matrix" \
  "link:$REPO/packages/dsh-companion" \
  "link:$REPO/packages/dsh-imagegen"
systemctl --user restart dsh.service
for attempt in $(seq 1 30); do \
  if systemctl --user is-active --quiet dsh.service; then \
    http_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3080/ || true)"; \
    if [ "$http_status" = "401" ]; then \
      break; \
    fi \
  fi; \
  if [ "$attempt" -eq 30 ]; then \
    echo "dsh.service did not become active behind the expected HTTP 401 boundary" >&2; \
    exit 1; \
  fi; \
  sleep 1; \
done
DSH_HOME="$DSH_HOME" "$DSH_CLI" --profile web --dump-config
for package in dsh-speech dsh-hindsight dsh-matrix dsh-companion dsh-imagegen; do \
  test "$(readlink -f "$DSH_HOME/profiles/web/node_modules/@lamplitisles/$package")" = "$REPO/packages/$package"; \
done
corepack pnpm run identities:migrate -- check --dsh-home "$DSH_HOME" --profile web
trap - EXIT
)
```

If a command after the service stop fails, the subshell cleanup leaves the
service stopped while investigating. The affected YAML files can be restored
from the two files in `$BACKUP_DIR` (preserving their original names and
modes), then the old and new package entries can be reconciled with the same
DSH plugin manager before restarting. On successful completion the cleanup
trap is removed and the service remains running for the manual cold-client
check. If that manual check fails, stop the service while investigating. Do
not delete the backup until the readiness and cold-client checks pass; the
migration tool refuses to overwrite an existing backup file.

The final live step is manual cold-client verification: open a newly created
browser session at the restarted Web UI, confirm the DSH Speech and DSH
Hindsight settings contributions load, and verify the five installed package
symlinks resolve to this checkout. Confirm that the new settings namespaces
retain the prior provider/voice and bank configuration and that the two new
credential references resolve through DSH's write-only credential surface,
without displaying or copying their values. Do not make paid Speech/Imagegen
requests, send mail or Matrix events, or mutate Hindsight memory as part of
this check.

This task does not publish npm packages, configure Trusted Publishing, update
a GitHub mirror, or migrate another profile.
