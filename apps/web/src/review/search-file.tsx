import type { CodeSearchMatch, DiffDocument, ReviewFileContent } from '@legible/protocol'
import { useEffect, useMemo, useState } from 'react'
import { fetchSearchFile } from '../api.js'
import { CodeView, type InlineWidget, type AnchorRange } from './code-view.js'
import { buildWholeFileRenderModel, type DiffAnchor, type RenderModel } from './render-model.js'

export function SearchFile({
  sessionId,
  revision,
  headSha,
  target,
  query,
  diff,
  onAnchorSelect,
  widgetsFor,
  selectedAnchor,
  selectedRange,
}: {
  sessionId: string
  revision: number
  headSha: string
  target: CodeSearchMatch
  query: string
  diff: DiffDocument
  onAnchorSelect(anchor: DiffAnchor, extend: boolean): void
  widgetsFor(model: RenderModel): InlineWidget[]
  selectedAnchor?: DiffAnchor | undefined
  selectedRange?: AnchorRange | undefined
}) {
  const [file, setFile] = useState<ReviewFileContent>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void fetchSearchFile(sessionId, target.path, revision, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return
        if (loaded.sha !== headSha || loaded.path !== target.path) {
          setError('Review changed. Search again.')
          return
        }
        setFile(loaded)
        setError(undefined)
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'File unavailable')
      },
    )
    return () => controller.abort()
  }, [sessionId, target.path, revision, headSha, retry])
  const model = useMemo(
    () =>
      file
        ? buildWholeFileRenderModel(
            file,
            diff.files.find((entry) => entry.newPath === file.path),
          )
        : undefined,
    [file, diff],
  )
  if (error)
    return (
      <div className="viewer-state" role="alert">
        {error}
        <button onClick={() => setRetry((value) => value + 1)}>Retry file</button>
      </div>
    )
  if (!file || !model) return <div className="viewer-state">Loading search file…</div>
  return (
    <CodeView
      model={model}
      onAnchorSelect={onAnchorSelect}
      initialQuery={query}
      focusLine={target.line}
      scrollRequest={{ line: target.line, nonce: target.line }}
      inlineWidgets={widgetsFor(model)}
      selectedAnchor={selectedAnchor}
      selectedRange={selectedRange}
    />
  )
}
