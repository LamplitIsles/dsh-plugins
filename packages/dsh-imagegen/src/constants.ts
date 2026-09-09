export const DEFAULT_GENERATION_MODEL = "gpt-image-2.5-flare";
export const DEFAULT_EDIT_MODEL = "gpt-image-2.5-sunburst";

export interface ImagegenSettings {
  bridgeUrl: string;
  generationModel: string;
  editModel: string;
}
