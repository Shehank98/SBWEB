// Shorten user text to at most n characters without cutting an emoji or a
// Sinhala / Tamil letter in half (String#slice counts UTF-16 units, and a cut
// in the middle of a pair shows up as "�" on the storefront).
export function clip(value, n) {
  const s = String(value == null ? '' : value);
  if (s.length <= n) return s;
  const chars = Array.from(s);                // whole code points
  let out = chars.slice(0, n).join('');
  // Do not leave a dangling joiner or variation selector at the end.
  out = out.replace(/[‍️]+$/u, '');
  return out;
}
