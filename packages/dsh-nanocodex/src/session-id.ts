const DSH_SESSION_ID =
  /^session-([0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

/** Convert the DSH `session-<UUID>` identity to Nanocodex's UUID identity. */
export function normalizeNanocodexSessionId(value: string): string {
  const match = DSH_SESSION_ID.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(
      `Nanocodex requires a DSH session ID in the form session-<UUIDv4|UUIDv7>, got ${JSON.stringify(value)}`,
    );
  }
  return match[1].toLowerCase();
}
