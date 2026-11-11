// Stable, diff-friendly JSON formatting for track.json. Pure (no DOM), so tools and tests use it too.
// Rule: anything whose one-line form fits in MAX_INLINE chars goes on one line; otherwise expand.
// Key order and unknown keys are preserved, so load -> export is lossless.

const MAX_INLINE = 100;

function inline(v: unknown): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

function format(v: unknown, indent: string): string {
  const one = inline(v);
  if (indent.length + one.length <= MAX_INLINE || v === null || typeof v !== 'object') return one;
  const inner = indent + '  ';
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + format(x, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`).join(',\n')}\n${indent}}`;
}

export function formatTrackJson(value: unknown): string {
  return format(value, '') + '\n';
}
