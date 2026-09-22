export type TextMatch = { from: number; to: number }

/** Literal, case-sensitive UTF-16 offsets, matching CodeMirror's document positions. */
export function findText(
  document: string,
  query: string,
): { matches: TextMatch[]; truncated: boolean } {
  const matches: TextMatch[] = []
  if (!query || query.includes('\n') || query.includes('\r')) return { matches, truncated: false }
  let at = 0
  while (at <= document.length - query.length) {
    const from = document.indexOf(query, at)
    if (from < 0) break
    if (matches.length === 1000) return { matches, truncated: true }
    matches.push({ from, to: from + query.length })
    at = from + query.length
  }
  return { matches, truncated: false }
}
