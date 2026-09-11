// Maintained by the Nanocodex DSH adapter; see THIRD_PARTY_NOTICES.md.
export type PatchErrorCode =
  | "PATCH_INVALID"
  | "PATCH_UNSUPPORTED"
  | "PATCH_CONTEXT_NOT_FOUND"
  | "PATCH_TOO_LARGE"
  | "PATCH_PATH_INVALID";

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly line?: number;

  constructor(
    message: string,
    code: PatchErrorCode,
    options: ErrorOptions & { line?: number } = {},
  ) {
    super(message, options);
    this.name = "PatchError";
    this.code = code;
    if (options.line !== undefined) this.line = options.line;
  }
}

export function patchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
