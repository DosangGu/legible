export type DirectoryEntry = {
  name: string
  path: string
  repository: boolean
}

export type DirectoryListing = {
  root: string
  path: string
  parent?: string
  repository: boolean
  entries: DirectoryEntry[]
  truncated: boolean
}
