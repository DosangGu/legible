import type {
  DiffDocument,
  DraftComment,
  ReviewEvent,
  ReviewFileContent,
  ReviewSession,
} from '@legible/protocol'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

import {
  ApiClientError,
  cleanupSubmission,
  fetchReviewFile,
  fetchSession,
  fetchSessionDiff,
  reconcileSubmission,
  submitReview,
} from '../api.js'
import { useDaemonEvents } from '../events-context.js'
import { CodeView, type InlineWidget, type ScrollRequest } from './code-view.js'
import { ChatPanel, type ChatItemView } from './chat-panel.js'
import { DraftCommentCard, NewCommentComposer } from './inline-comments.js'
import { useComments } from './use-comments.js'
import {
  buildDiffRenderModel,
  buildWholeFileRenderModel,
  defaultFileTarget,
  type DiffAnchor,
} from './render-model.js'

type DiffLoadState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; session: ReviewSession; diff?: DiffDocument }

export function ReviewPage() {
  const { sessionId = '' } = useParams()
  const [retry, setRetry] = useState(0)
  const requestKey = `${sessionId}:${String(retry)}`
  const [loadedDiff, setLoadedDiff] = useState<DiffLoadState>({ key: '', status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void fetchSession(sessionId, controller.signal)
      .then(async (session) => ({
        session,
        ...(session.submission
          ? {}
          : { diff: await fetchSessionDiff(sessionId, controller.signal) }),
      }))
      .then(
        ({ session, diff }) =>
          setLoadedDiff({ key: requestKey, status: 'ready', session, ...(diff ? { diff } : {}) }),
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
  if (diffState.session.submission) {
    return (
      <SubmissionPage
        session={diffState.session}
        onSessionChange={(session) => setLoadedDiff({ key: requestKey, status: 'ready', session })}
        onDraftRestored={() => setRetry((value) => value + 1)}
      />
    )
  }
  if (!diffState.diff || diffState.diff.files.length === 0) {
    return <PageState title="No changes" detail="The pinned revisions have no diff." />
  }

  return (
    <ReviewWorkspace
      session={diffState.session}
      diff={diffState.diff}
      onSubmitted={(session) => setLoadedDiff({ key: requestKey, status: 'ready', session })}
    />
  )
}

function ReviewWorkspace({
  session,
  diff,
  onSubmitted,
}: {
  session: ReviewSession
  diff: DiffDocument
  onSubmitted(session: ReviewSession): void
}) {
  const sessionId = session.id
  const events = useDaemonEvents()
  const model = useMemo(() => buildDiffRenderModel(diff), [diff])
  const draftComments = useComments(sessionId)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'diff' | 'whole'>('diff')
  const [anchor, setAnchor] = useState<DiffAnchor>()
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>()
  const [fileCache, setFileCache] = useState(() => new Map<string, ReviewFileContent>())
  const [fileError, setFileError] = useState<{ key: string; message: string }>()
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [selectedChatItemId, setSelectedChatItemId] = useState<string>()
  const [knownChatItems, setKnownChatItems] = useState<Map<string, ChatItemView>>(() => new Map())
  const [commentRange, setCommentRange] = useState<CommentRange>()
  const [focusedRange, setFocusedRange] = useState<CommentRange>()
  const [commentBody, setCommentBody] = useState('')
  const [commentError, setCommentError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const selectedFile = selectedDiffFile(diff, selectedFileIndex)
  const target = defaultFileTarget(selectedFile)
  const targetSha = target.side === 'RIGHT' ? diff.headSha : diff.baseSha
  const fileKey = `${targetSha}\0${target.side}\0${target.path}`
  const cachedFile = fileCache.get(fileKey)

  const liveCommentIds = new Set(draftComments.comments.map((comment) => comment.id))
  const chatItems = [
    ...draftComments.comments.map((comment, index) => chatItem(comment, index + 1, false)),
    ...[...knownChatItems.values()]
      .filter((item) => !liveCommentIds.has(item.id))
      .map((item) => ({ ...item, deleted: true })),
  ]
  const selectedChatItem = chatItems.find((item) => item.id === selectedChatItemId)

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

  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'review.focus.requested' || event.payload.sessionId !== sessionId) {
          return
        }
        const { path, side, line, startLine } = event.payload
        const index = diff.files.findIndex((file) =>
          side === 'LEFT' ? file.oldPath === path : file.newPath === path,
        )
        const start = findAnchor(model, path, side, startLine ?? line)
        const end = findAnchor(model, path, side, line)
        if (index < 0 || !start || !end) return
        setSelectedFileIndex(index)
        setViewMode('diff')
        setCommentRange(undefined)
        setFocusedRange({ start, end })
        setAnchor(end)
        const renderedLine = findRenderedLine(model, end)
        if (renderedLine !== undefined) {
          setScrollRequest((current) => ({
            line: renderedLine,
            nonce: (current?.nonce ?? 0) + 1,
          }))
        }
      }),
    [diff.files, events, model, sessionId],
  )

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

  const selectAnchor = (selected: DiffAnchor, extend: boolean) => {
    setAnchor(selected)
    setFocusedRange(undefined)
    setCommentError(undefined)
    setCommentRange((current) => {
      if (
        !extend ||
        !current ||
        current.start.path !== selected.path ||
        current.start.side !== selected.side ||
        current.start.rangeKey !== selected.rangeKey
      ) {
        setCommentBody('')
        return { start: selected, end: selected }
      }
      return selected.line < current.start.line
        ? { start: selected, end: current.start }
        : { start: current.start, end: selected }
    })
  }

  const openCommentChat = (comment: DraftComment, number: number) => {
    setKnownChatItems((current) => {
      const next = new Map(current)
      next.set(comment.id, chatItem(comment, number, false))
      return next
    })
    setSelectedChatItemId(comment.id)
    setChatCollapsed(false)
    focusComment(comment)
  }

  const focusComment = (comment: Pick<DraftComment, 'path' | 'side' | 'line' | 'startLine'>) => {
    const index = diff.files.findIndex((file) =>
      comment.side === 'LEFT' ? file.oldPath === comment.path : file.newPath === comment.path,
    )
    const start = findAnchor(model, comment.path, comment.side, comment.startLine ?? comment.line)
    const end = findAnchor(model, comment.path, comment.side, comment.line)
    if (index < 0 || !start || !end) return
    setSelectedFileIndex(index)
    setViewMode('diff')
    setCommentRange(undefined)
    setFocusedRange({ start, end })
    setAnchor(end)
    const renderedLine = findRenderedLine(model, end)
    if (renderedLine !== undefined) {
      setScrollRequest((current) => ({
        line: renderedLine,
        nonce: (current?.nonce ?? 0) + 1,
      }))
    }
  }

  const widgetsFor = (rendered: ReturnType<typeof buildDiffRenderModel>): InlineWidget[] => {
    const widgets: InlineWidget[] = []
    for (const [index, comment] of draftComments.comments.entries()) {
      const commentAnchor = findAnchor(rendered, comment.path, comment.side, comment.line)
      if (!commentAnchor) continue
      widgets.push({
        id: `comment:${comment.id}:${comment.body}:${String(selectedChatItemId === comment.id)}`,
        anchor: commentAnchor,
        content: (
          <DraftCommentCard
            comment={comment}
            discussing={selectedChatItemId === comment.id}
            onDiscuss={() => openCommentChat(comment, index + 1)}
            onUpdate={async (body) => {
              await draftComments.update(comment.id, body)
            }}
            onRemove={() => draftComments.remove(comment.id)}
          />
        ),
      })
    }
    if (commentRange) {
      widgets.push({
        id: `composer:${commentRange.end.path}:${commentRange.end.side}:${String(commentRange.end.line)}`,
        anchor: commentRange.end,
        content: (
          <NewCommentComposer
            rangeLabel={formatRange(commentRange)}
            body={commentBody}
            error={commentError}
            onBodyChange={setCommentBody}
            onCancel={() => {
              setCommentRange(undefined)
              setCommentBody('')
              setCommentError(undefined)
            }}
            onSubmit={async () => {
              try {
                await draftComments.create({
                  path: commentRange.end.path,
                  side: commentRange.end.side,
                  line: commentRange.end.line,
                  ...(commentRange.start.line !== commentRange.end.line
                    ? {
                        startLine: commentRange.start.line,
                        startSide: commentRange.start.side,
                      }
                    : {}),
                  body: commentBody,
                })
                setCommentRange(undefined)
                setCommentBody('')
                setCommentError(undefined)
              } catch (error) {
                setCommentError(errorMessage(error))
              }
            }}
          />
        ),
      })
    }
    return widgets
  }

  let viewer = (
    <CodeView
      model={model}
      selectedAnchor={anchor}
      selectedRange={commentRange ?? focusedRange}
      onAnchorSelect={selectAnchor}
      scrollRequest={scrollRequest}
      inlineWidgets={widgetsFor(model)}
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
      const wholeModel = buildWholeFileRenderModel(cachedFile, selectedFile)
      viewer = (
        <CodeView
          model={wholeModel}
          selectedAnchor={anchor}
          selectedRange={commentRange ?? focusedRange}
          onAnchorSelect={selectAnchor}
          inlineWidgets={widgetsFor(wholeModel)}
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
          <span>{String(draftComments.comments.length)} drafts</span>
          <button className="primary-button" type="button" onClick={() => setSubmitting(true)}>
            Submit review
          </button>
        </div>
      </header>

      {submitting && (
        <SubmitReviewDialog
          session={session}
          draftCount={draftComments.comments.length}
          onClose={() => setSubmitting(false)}
          onSubmitted={onSubmitted}
        />
      )}

      <div className={chatCollapsed ? 'review-body chat-is-collapsed' : 'review-body'}>
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
              (draftComments.error ??
              'Select a line number to draft a comment. Shift-click to extend.')
            )}
          </footer>
        </section>
        <ChatPanel
          sessionId={sessionId}
          collapsed={chatCollapsed}
          {...(selectedChatItemId === undefined ? {} : { selectedItemId: selectedChatItemId })}
          {...(selectedChatItem === undefined ? {} : { item: selectedChatItem })}
          items={chatItems}
          onSelectItem={(itemId) => {
            setSelectedChatItemId(itemId)
            setChatCollapsed(false)
            const selected = chatItems.find((item) => item.id === itemId)
            if (selected && !selected.deleted) focusComment(selected)
          }}
          onToggle={() => setChatCollapsed((value) => !value)}
        />
      </div>
    </main>
  )
}

function SubmitReviewDialog({
  session,
  draftCount,
  onClose,
  onSubmitted,
}: {
  session: ReviewSession
  draftCount: number
  onClose(): void
  onSubmitted(session: ReviewSession): void
}) {
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [stale, setStale] = useState<{ pinned: string; current: string }>()
  const bodyRequired = event === 'COMMENT' || event === 'REQUEST_CHANGES'

  const submit = async (allowStaleHead = false) => {
    setSaving(true)
    setError(undefined)
    try {
      onSubmitted(
        await submitReview(session.id, {
          event,
          ...(body.trim() ? { body } : {}),
          ...(allowStaleHead ? { allowStaleHead: true } : {}),
        }),
      )
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'stale_pr_head') {
        setStale({
          pinned: String(caught.details?.pinnedHeadSha ?? session.headSha),
          current: String(caught.details?.currentHeadSha ?? 'unknown'),
        })
      } else {
        setError(errorMessage(caught))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="submit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="submit-title"
      >
        <h2 id="submit-title">Submit review</h2>
        <p>
          {String(draftCount)} inline drafts · pinned <code>{session.headSha}</code>
        </p>
        <fieldset disabled={saving}>
          <legend>Review decision</legend>
          {(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="review-event"
                value={value}
                checked={event === value}
                onChange={() => {
                  setEvent(value)
                  setStale(undefined)
                }}
              />
              {reviewEventLabel(value)}
            </label>
          ))}
        </fieldset>
        <label className="submit-body-label">
          Review summary{bodyRequired ? ' (required)' : ''}
          <textarea
            aria-label="Review summary"
            maxLength={64 * 1024}
            value={body}
            disabled={saving}
            onChange={(change) => {
              setBody(change.target.value)
              setStale(undefined)
            }}
          />
        </label>
        {stale && (
          <div className="submit-warning">
            PR HEAD changed from <code>{stale.pinned}</code> to <code>{stale.current}</code>. You
            can still submit against the pinned revision.
          </div>
        )}
        {error && <div className="submit-error">{error}</div>}
        <div className="submit-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving || (bodyRequired && !body.trim())}
            onClick={() => void submit(Boolean(stale))}
          >
            {saving ? 'Submitting…' : stale ? 'Submit pinned review anyway' : 'Submit review'}
          </button>
        </div>
      </section>
    </div>
  )
}

function SubmissionPage({
  session,
  onSessionChange,
  onDraftRestored,
}: {
  session: ReviewSession
  onSessionChange(session: ReviewSession): void
  onDraftRestored(): void
}) {
  const submission = session.submission!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = async (operation: () => Promise<ReviewSession>) => {
    setBusy(true)
    setError(undefined)
    try {
      const updated = await operation()
      if (!updated.submission) onDraftRestored()
      else onSessionChange(updated)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  if (submission.status !== 'submitted') {
    return (
      <PageState
        title="Submission result unknown"
        detail="Check GitHub for the hidden session marker before allowing another submission."
      >
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void run(() => reconcileSubmission(session.id))}
        >
          {busy ? 'Checking…' : 'Reconcile with GitHub'}
        </button>
        {error ? <p>{error}</p> : null}
      </PageState>
    )
  }

  return (
    <PageState
      title="Review submitted"
      detail={`${reviewEventLabel(submission.event)} · ${submission.submittedAt}`}
    >
      <a className="primary-button" href={submission.htmlUrl} target="_blank" rel="noreferrer">
        Open on GitHub
      </a>
      {submission.staleHead ? <p>Submitted against the pinned, older HEAD.</p> : null}
      {submission.cleanup.status === 'failed' ? (
        <>
          <p>Worktree cleanup failed: {submission.cleanup.message}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => cleanupSubmission(session.id))}
          >
            {busy ? 'Cleaning…' : 'Retry cleanup'}
          </button>
        </>
      ) : (
        <p>Worktree cleanup {submission.cleanup.status}.</p>
      )}
      {error ? <p>{error}</p> : null}
    </PageState>
  )
}

function reviewEventLabel(event: ReviewEvent): string {
  if (event === 'APPROVE') return 'Approve'
  if (event === 'REQUEST_CHANGES') return 'Request changes'
  return 'Comment'
}

type CommentRange = { start: DiffAnchor; end: DiffAnchor }

function findAnchor(
  model: ReturnType<typeof buildDiffRenderModel>,
  path: string,
  side: 'LEFT' | 'RIGHT',
  line: number,
): DiffAnchor | undefined {
  for (const rendered of model.lines) {
    const anchor = side === 'LEFT' ? rendered.leftAnchor : rendered.rightAnchor
    if (anchor?.path === path && anchor.line === line) return anchor
  }
  return undefined
}

function findRenderedLine(
  model: ReturnType<typeof buildDiffRenderModel>,
  target: DiffAnchor,
): number | undefined {
  const index = model.lines.findIndex((rendered) => {
    const anchor = target.side === 'LEFT' ? rendered.leftAnchor : rendered.rightAnchor
    return anchor?.path === target.path && anchor.line === target.line
  })
  return index < 0 ? undefined : index + 1
}

function formatRange(range: CommentRange): string {
  return range.start.line === range.end.line
    ? `${range.end.side} ${String(range.end.line)}`
    : `${range.end.side} ${String(range.start.line)}–${String(range.end.line)}`
}

function chatItem(comment: DraftComment, number: number, deleted: boolean): ChatItemView {
  return {
    id: comment.id,
    number,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
    body: comment.body,
    deleted,
  }
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
