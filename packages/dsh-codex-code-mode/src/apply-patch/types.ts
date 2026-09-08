/** The deliberately small operation set accepted by the direct Codex tool. */
export type PatchOperation = AddFileOperation | UpdateFileOperation;

export interface AddFileOperation {
  readonly kind: "add";
  readonly path: string;
  content: string;
  readonly line: number;
}

export interface UpdateFileOperation {
  readonly kind: "update";
  readonly path: string;
  chunks: UpdateChunk[];
  readonly line: number;
}

export interface UpdateChunk {
  readonly changeContext?: string;
  readonly oldLines: string[];
  readonly newLines: string[];
  readonly contextLineIndices: Array<
    readonly [oldIndex: number, newIndex: number]
  >;
  isEndOfFile: boolean;
  readonly line: number;
}

export interface ParsedPatch {
  readonly operations: PatchOperation[];
  readonly normalizedPatch: string;
}

export interface PresentationDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}
