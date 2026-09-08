// Ported from OpenAI Codex apply-patch (Apache-2.0); see THIRD_PARTY_NOTICES.md.
// Rust char::is_whitespace characters used by the Codex parser/matcher.
function isRustWhitespace(character: string | undefined): boolean {
  const codePoint = character?.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x09 && codePoint <= 0x0d) ||
      codePoint === 0x20 ||
      codePoint === 0x85 ||
      codePoint === 0xa0 ||
      codePoint === 0x1680 ||
      (codePoint >= 0x2000 && codePoint <= 0x200a) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x202f ||
      codePoint === 0x205f ||
      codePoint === 0x3000)
  );
}

export function rustTrimStart(value: string): string {
  let start = 0;
  while (start < value.length && isRustWhitespace(value[start])) start += 1;
  return value.slice(start);
}

export function rustTrimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && isRustWhitespace(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}
