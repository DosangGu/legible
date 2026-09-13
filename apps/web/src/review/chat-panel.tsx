import { AgentBackendKind } from '@legible/protocol'
import type { ChatEntry, DiffSide } from '@legible/protocol'
import { useState, type FormEvent } from 'react'

import { useChat } from './use-chat.js'

export interface ChatItemView {
  id: string
  number: number
  path: string
  line: number
  side: DiffSide
  startLine?: number
  body: string
  deleted: boolean
}

export function ChatPanel({
  sessionId,
  collapsed,
  selectedItemId,
  item,
  items,
  onSelectItem,
  onToggle,
}: {
  sessionId: string
  collapsed: boolean
  selectedItemId?: string
  item?: ChatItemView
  items: ChatItemView[]
  onSelectItem(itemId?: string): void
  onToggle(): void
}) {
  const chat = useChat(sessionId)
  const [message, setMessage] = useState('')
  const [commandFailure, setCommandFailure] = useState<{
    itemId?: string
    message: string
  }>()
  const snapshot = chat.snapshot
  const backendLabel = snapshot?.backend === AgentBackendKind.Claude ? 'Claude' : 'Codex'
  const busy = snapshot ? ['starting', 'running', 'interrupting'].includes(snapshot.status) : false
  const busyHere = busy && snapshot?.currentItemId === selectedItemId
  const retryHere = snapshot?.status === 'failed' && snapshot.retryItemId === selectedItemId
  const entries =
    snapshot?.entries.filter(
      (entry) =>
        entry.itemId === selectedItemId || (entry.kind === 'notice' && entry.scope === 'session'),
    ) ?? []
  const deleted = selectedItemId !== undefined && item?.deleted !== false
  const commandError =
    commandFailure && commandFailure.itemId === selectedItemId ? commandFailure.message : undefined

  const run = async (command: () => Promise<unknown>) => {
    setCommandFailure(undefined)
    try {
      await command()
      return true
    } catch (error) {
      setCommandFailure({
        ...(selectedItemId === undefined ? {} : { itemId: selectedItemId }),
        message: error instanceof Error ? error.message : 'Chat command failed',
      })
      return false
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!message.trim() || busy || deleted) return
    const sent = message
    setMessage('')
    void run(() => chat.send(sent, selectedItemId)).then((succeeded) => {
      if (!succeeded) setMessage(sent)
    })
  }

  const activeItem = items.find((candidate) => candidate.id === snapshot?.currentItemId)
  const failedItem = items.find((candidate) => candidate.id === snapshot?.retryItemId)

  return (
    <aside className={collapsed ? 'chat-panel chat-panel-collapsed' : 'chat-panel'}>
      <header className="chat-header">
        {!collapsed && (
          <div className="chat-heading">
            {selectedItemId && (
              <button className="chat-back" type="button" onClick={() => onSelectItem()}>
                ← Main review
              </button>
            )}
            <strong>
              {selectedItemId
                ? item && !item.deleted
                  ? `Comment #${String(item.number)}`
                  : 'Deleted comment'
                : backendLabel}
            </strong>
            <span>
              {item
                ? `${item.path} · ${formatRange(item)}`
                : selectedItemId
                  ? 'This comment no longer exists'
                  : (snapshot?.model ?? 'Main review')}
            </span>
          </div>
        )}
        <button
          className="chat-toggle"
          type="button"
          aria-label={collapsed ? 'Open chat' : 'Collapse chat'}
          onClick={onToggle}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </header>

      {!collapsed && (
        <>
          <div className="chat-transcript" aria-live="polite">
            {!snapshot && !chat.loadError && <ChatEmpty text="Loading chat…" />}
            {chat.loadError && <ChatEmpty text={chat.loadError} />}
            {snapshot?.status === 'unavailable' && (
              <ChatEmpty text={snapshot.unavailableReason ?? 'Chat is unavailable'} />
            )}
            {selectedItemId && item && !item.deleted && entries.length === 0 && (
              <div className="chat-item-context">
                <strong>Comment #{item.number}</strong>
                <p>{item.body}</p>
              </div>
            )}
            {deleted && (
              <ChatEmpty text="This comment was deleted. Its conversation is read-only." />
            )}
            {!selectedItemId &&
              snapshot &&
              entries.length === 0 &&
              snapshot.entries.length === 0 &&
              snapshot.status !== 'unavailable' && (
                <div className="chat-start">
                  <p>Ask {backendLabel} to review the pinned diff and investigate related code.</p>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(chat.start)}
                  >
                    {busy ? 'Starting…' : 'Start review'}
                  </button>
                </div>
              )}
            {entries.map((entry) => (
              <ChatEntryView key={entry.id} entry={entry} />
            ))}
            {busy && !busyHere && (
              <ConversationRouteNotice
                label={activeItem ? `Comment #${String(activeItem.number)}` : 'Main review'}
                action="Open active chat"
                onOpen={() => onSelectItem(snapshot?.currentItemId)}
              />
            )}
            {snapshot?.status === 'failed' && !retryHere && (
              <ConversationRouteNotice
                label={failedItem ? `Comment #${String(failedItem.number)}` : 'Main review'}
                action="Open failed chat"
                onOpen={() => onSelectItem(snapshot.retryItemId)}
              />
            )}
          </div>

          {(commandError || retryHere) && (
            <div className="chat-command-error">
              <span>{commandError ?? 'The last turn failed.'}</span>
              {retryHere && (
                <button type="button" onClick={() => void run(chat.retry)}>
                  Retry
                </button>
              )}
            </div>
          )}

          {snapshot && snapshot.status !== 'unavailable' && !deleted && (
            <form className="chat-composer" onSubmit={submit}>
              <textarea
                aria-label="Chat message"
                maxLength={16 * 1024}
                placeholder={selectedItemId ? 'Ask about this comment…' : 'Ask about the review…'}
                value={message}
                disabled={busy}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              {busyHere ? (
                <button
                  type="button"
                  disabled={snapshot.status === 'interrupting'}
                  onClick={() => void run(chat.interrupt)}
                >
                  {snapshot.status === 'interrupting' ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button type="submit" disabled={busy || !message.trim()}>
                  Send
                </button>
              )}
            </form>
          )}
        </>
      )}
    </aside>
  )
}

function ConversationRouteNotice({
  label,
  action,
  onOpen,
}: {
  label: string
  action: string
  onOpen(): void
}) {
  return (
    <div className="chat-route-notice">
      <span>{label}</span>
      <button type="button" onClick={onOpen}>
        {action}
      </button>
    </div>
  )
}

function ChatEntryView({ entry }: { entry: ChatEntry }) {
  if (entry.kind === 'message') {
    return <div className={`chat-message chat-message-${entry.role}`}>{entry.text}</div>
  }
  if (entry.kind === 'notice') {
    return <div className={`chat-notice chat-notice-${entry.level}`}>{entry.message}</div>
  }
  return (
    <details className="chat-tool">
      <summary>
        <span>
          {entry.status === 'running'
            ? 'Working'
            : entry.status === 'failed'
              ? 'Failed'
              : 'Activity'}
        </span>
        <strong>{entry.name}</strong>
      </summary>
      <pre>{entry.input}</pre>
      {entry.output !== undefined && <pre>{entry.output}</pre>}
    </details>
  )
}

function ChatEmpty({ text }: { text: string }) {
  return <div className="chat-empty">{text}</div>
}

function formatRange(item: Pick<ChatItemView, 'startLine' | 'line' | 'side'>): string {
  const lines = item.startLine === undefined ? String(item.line) : `${item.startLine}–${item.line}`
  return `${item.side} ${lines}`
}
