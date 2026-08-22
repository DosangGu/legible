import type { DiffDocument, ReviewFileContent } from '@legible/protocol'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

import { fetchReviewFile, fetchSessionDiff } from '../api.js'
import { CodeView, type ScrollRequest } from './code-view.js'
import {
  buildDiffRenderModel,
  buildWholeFileRenderModel,
  defaultFileTarget,
  type DiffAnchor,
} from './render-model.js'

type DiffLoadState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; diff: DiffDocument }

export function ReviewPage() {
  const { sessionId = '' } = useParams()
  const [retry, setRetry] = useState(0)
  const requestKey = `${sessionId}:${String(retry)}`
  const [loadedDiff, setLoadedDiff] = useState<DiffLoadState>({ key: '', status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void fetchSessionDiff(sessionId, controller.signal).then(
      (diff) => setLoadedDiff({ key: requestKey, status: 'ready', diff }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadedDiff({ key: requestKey, status: 'error', message: errorMessage(error) })
        }
      },
    )
    return () => controller.abort()
  }, [requestKey, sessionId])

  const diffState: DiffLoadState =
    loadedDiff.key === requestKey ? loadedDiff : { key: requestKey, status: 'loading' }

  if (diffState.status === 'loading') return <PageState title="Loading review…" />
  if (diffState.status === 'error') {
    return (
      <PageState title="Unable to load review" detail={diffState.message}>
        <button
          className="primary-button"
          type="button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry
        </button>
      </PageState>
    )
  }
  if (diffState.diff.files.length === 0) {
    return <PageState title="No changes" detail="The pinned revisions have no diff." />
  }

  return <ReviewWorkspace sessionId={sessionId} diff={diffState.diff} />
}

function ReviewWorkspace({ sessionId, diff }: { sessionId: string; diff: DiffDocument }) {
  const model = useMemo(() => buildDiffRenderModel(diff), [diff])
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'diff' | 'whole'>('diff')
  const [anchor, setAnchor] = useState<DiffAnchor>()
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>()
  const [fileCache, setFileCache] = useState(() => new Map<string, ReviewFileContent>())
  const [fileError, setFileError] = useState<{ key: string; message: string }>()
  const selectedFile = selectedDiffFile(diff, selectedFileIndex)
  const target = defaultFileTarget(selectedFile)
  const targetSha = target.side === 'RIGHT' ? diff.headSha : diff.baseSha
  const fileKey = `${targetSha}\0${target.side}\0${target.path}`
  const cachedFile = fileCache.get(fileKey)

  useEffect(() => {
    if (viewMode !== 'whole' || cachedFile) return

    const controller = new AbortController()
    void fetchReviewFile(sessionId, target.path, target.side, controller.signal).then(
      (file) => {
        setFileCache((current) => {
          const next = new Map(current)
          next.set(fileKey, file)
          return next
        })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setFileError({ key: fileKey, message: errorMessage(error) })
        }
      },
    )
    return () => controller.abort()
  }, [cachedFile, fileKey, sessionId, target.path, target.side, viewMode])

  const chooseFile = (index: number) => {
    setSelectedFileIndex(index)
    const rendered = model.files[index]
    if (viewMode === 'diff' && rendered) {
      setScrollRequest((current) => ({
        line: rendered.startLine,
        nonce: (current?.nonce ?? 0) + 1,
      }))
    }
  }

  let viewer = (
    <CodeView
      model={model}
      selectedAnchor={anchor}
      onAnchorSelect={setAnchor}
      scrollRequest={scrollRequest}
    />
  )

  if (viewMode === 'whole') {
    if (!cachedFile && fileError?.key !== fileKey) {
      viewer = <ViewerState title="Loading whole file…" />
    } else if (!cachedFile) {
      viewer = <ViewerState title="Unable to load file" detail={fileError?.message} />
    } else if (cachedFile.isBinary) {
      viewer = (
        <ViewerState
          title="Binary file"
          detail={`${formatBytes(cachedFile.byteLength)} · preview unavailable`}
        />
      )
    } else if (cachedFile.content === '') {
      viewer = <ViewerState title="Empty file" />
    } else {
      viewer = (
        <CodeView
          model={buildWholeFileRenderModel(cachedFile, selectedFile)}
          selectedAnchor={anchor}
          onAnchorSelect={setAnchor}
        />
      )
    }
  }

  return (
    <main className="review-shell">
      <header className="review-header">
        <div className="review-title">
          <span className="brand-mark brand-mark-small">L</span>
          <div>
            <p className="eyebrow">Review session</p>
            <h1>{sessionId}</h1>
          </div>
        </div>
        <div className="revision-summary">
          <span>HEAD</span>
          <code title={diff.headSha}>{diff.headSha}</code>
        </div>
        <div className="diff-summary" aria-label="Diff summary">
          <strong>{String(diff.files.length)}</strong> files
          <span className="additions">+{String(diff.additions)}</span>
          <span className="deletions">−{String(diff.deletions)}</span>
        </div>
      </header>

      <div className="review-body">
        <aside className="file-sidebar" aria-label="Changed files">
          <div className="sidebar-heading">Changed files</div>
          <nav>
            {diff.files.map((file, index) => {
              const path = file.newPath ?? file.oldPath ?? '(unknown file)'
              return (
                <button
                  className={
                    index === selectedFileIndex ? 'file-button file-button-active' : 'file-button'
                  }
                  key={`${String(index)}:${path}`}
                  type="button"
                  title={path}
                  onClick={() => chooseFile(index)}
                >
                  <span className={`status-dot status-${file.status}`} aria-label={file.status} />
                  <span className="file-path">{path}</span>
                  <span className="file-stats">
                    <span className="additions">+{String(file.additions)}</span>
                    <span className="deletions">−{String(file.deletions)}</span>
                  </span>
                </button>
              )
            })}
          </nav>
        </aside>

        <section className="diff-panel">
          <div className="diff-toolbar">
            <div className="selected-path" title={target.path}>
              {target.path}
            </div>
            <div className="view-toggle" aria-label="View mode">
              <button
                className={viewMode === 'diff' ? 'toggle-active' : ''}
                type="button"
                onClick={() => setViewMode('diff')}
              >
                Diff
              </button>
              <button
                className={viewMode === 'whole' ? 'toggle-active' : ''}
                type="button"
                onClick={() => setViewMode('whole')}
              >
                Whole file
              </button>
            </div>
          </div>
          <div className="viewer-frame">{viewer}</div>
          <footer className="anchor-status" aria-live="polite">
            {anchor ? (
              <>
                Anchor <strong>{anchor.path}</strong>
                <span>{anchor.side}</span>
                <span>line {String(anchor.line)}</span>
              </>
            ) : (
              'Select a line number to anchor a future comment.'
            )}
          </footer>
        </section>
      </div>
    </main>
  )
}

function PageState({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children?: ReactNode
}) {
  return (
    <main className="placeholder-page">
      <div className="brand-mark">L</div>
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      {children}
    </main>
  )
}

function ViewerState({ title, detail }: { title: string; detail?: string | undefined }) {
  return (
    <div className="viewer-state">
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function selectedDiffFile(diff: DiffDocument, index: number) {
  const file = diff.files[index] ?? diff.files[0]
  if (!file) throw new Error('Review workspace requires at least one diff file')
  return file
}
