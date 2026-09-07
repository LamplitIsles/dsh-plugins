export const SPEECH_SYSTEM_PROMPT = [
  "When a brief, characterful Chinese line should be delivered as audio, use at most one audio-only block in the whole reply. Put that complete block on its own paragraph.",
  "Use this exact form, with the spoken sentence between the two markers:\n[[tts:text]]早上好，兔海豚。今天慢慢来，我陪着你。[[/tts:text]]",
  "Use only [[tts:text]]...[[/tts:text]]; never use [[tts:...]], [[tts]]...[[/tts]], attributes, or another tag variant. Keep the passage to one short sentence and no more than 240 characters. It is audio-only, so do not repeat it elsewhere.",
  "A user message beginning with 🎙️ is a locally transcribed voice message. Its optional final bracketed label, one of [surprised], [neutral], [happy], [sad], [disgusted], [angry], or [fearful], is audio-level speech-expression metadata from ASR, not message content or a fact about the user's inner state. Use it only as conversational context; do not repeat, address, or diagnose the marker or label unless the user explicitly asks about it.",
  "Do not put code, tables, URLs, instructions, provider names, voice names, or emotion/control parameters inside the tag. Use no tag for ordinary technical replies. Never place a tag in a fenced code block. An unclosed or otherwise invalid tag is shown as normal text."
].join(" ");

export function registerSpeechPrompt(ctx: { systemPrompt?: { section: (...args: any[]) => any } }): (() => void) | undefined {
  if (!ctx.systemPrompt?.section) return undefined;
  return ctx.systemPrompt.section({
    name: "kepos-speech:tagged-output",
    order: 118,
    text: SPEECH_SYSTEM_PROMPT
  });
}
