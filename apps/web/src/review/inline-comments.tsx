import type { DraftComment } from '@legible/protocol'
import { useState, type FormEvent } from 'react'

export function NewCommentComposer({
  rangeLabel,
  body,
  error,
  onBodyChange,
  onCancel,
  onSubmit,
}: {
  rangeLabel: string
  body: string
  error?: string | undefined
  onBodyChange(body: string): void
  onCancel(): void
  onSubmit(): Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    void onSubmit().finally(() => setSaving(false))
  }
  return (
    <form className="inline-comment-form" onSubmit={submit}>
      <strong>New comment · {rangeLabel}</strong>
      <textarea
        aria-label="Comment body"
        autoFocus
        maxLength={64 * 1024}
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
      />
      {error && <span className="inline-comment-error">{error}</span>}
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving || !body.trim()}>
          {saving ? 'Saving…' : 'Save comment'}
        </button>
      </div>
    </form>
  )
}

export function DraftCommentCard({
  comment,
  discussing,
  onDiscuss,
  onUpdate,
  onRemove,
}: {
  comment: DraftComment
  discussing: boolean
  onDiscuss(): void
  onUpdate(body: string): Promise<void>
  onRemove(): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(comment.body)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await onUpdate(body)
      setEditing(false)
    } catch (value) {
      setError(errorMessage(value))
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await onRemove()
    } catch (value) {
      setError(errorMessage(value))
      setSaving(false)
    }
  }

  return (
    <article
      className={
        discussing ? 'draft-comment-card draft-comment-card-discussing' : 'draft-comment-card'
      }
    >
      <header>
        <strong>{comment.origin}</strong>
        <span>{rangeLabel(comment)}</span>
      </header>
      {editing ? (
        <textarea
          aria-label="Edit comment body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      ) : (
        <p>{comment.body}</p>
      )}
      {error && <span className="inline-comment-error">{error}</span>}
      <footer>
        {editing ? (
          <>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" disabled={saving || !body.trim()} onClick={() => void save()}>
              Save
            </button>
          </>
        ) : (
          <>
            <button type="button" aria-pressed={discussing} onClick={onDiscuss}>
              Discuss
            </button>
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" disabled={saving} onClick={() => void remove()}>
              Delete
            </button>
          </>
        )}
      </footer>
    </article>
  )
}

function rangeLabel(comment: Pick<DraftComment, 'startLine' | 'line' | 'side'>): string {
  return comment.startLine === undefined
    ? `${comment.side} ${String(comment.line)}`
    : `${comment.side} ${String(comment.startLine)}–${String(comment.line)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Comment request failed'
}
