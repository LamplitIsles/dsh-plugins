export const RPC_CHANNEL = "/kepos-speech";
export const RPC_ENDPOINT = "synthesize";

export interface BrowserAudioPayload {
  mediaType: "audio/mpeg";
  /** Stable same-origin URL for the workspace-owned artifact. */
  url: string;
  bytes: number;
}
