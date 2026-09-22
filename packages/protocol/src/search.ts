export type CodeSearchMatch = {
  path: string
  line: number
  preview: string
}

export type CodeSearchResult = {
  reviewRevision: number
  headSha: string
  query: string
  matches: CodeSearchMatch[]
  truncated: boolean
  skippedLargeFiles: number
}
