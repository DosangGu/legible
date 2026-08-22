import type { ChatEntry } from '@legible/protocol'
import { useState, type FormEvent } from 'react'

import { useChat } from './use-chat.js'

export function ChatPanel({
  sessionId,
  collapsed,
  onToggle,
}: {
  sessionId: string
  collapsed: boolean
  onToggle(): void
}) {
  const chat = useChat(sessionId)
  const [message, setMessage] = useState('')
  const [commandError, setCommandError] = useState<string>()
  const snapshot = chat.snapshot
  const busy = snapshot ? ['starting', 'running', 'interrupting'].includes(snapshot.status) : false

  const run = async (command: () => Promise<unknown>) => {
    setCommandError(undefined)
    try {
      await command()
      return true
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : 'Chat command failed')
      return false
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!message.trim() || busy) return
    const sent = message
    setMessage('')
    void run(() => chat.send(sent)).then((succeeded) => {
      if (!succeeded) setMessage(sent)
    })
  }

  return (
    <aside className={collapsed ? 'chat-panel chat-panel-collapsed' : 'chat-panel'}>
      <header className="chat-header">
        {!collapsed && (
          <div>
            <strong>Codex</strong>
            <span>{snapshot?.model ?? 'Main review'}</span>
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
            {snapshot && snapshot.entries.length === 0 && snapshot.status !== 'unavailable' && (
              <div className="chat-start">
                <p>Ask Codex to review the pinned diff and investigate related code.</p>
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
            {snapshot?.entries.map((entry) => (
              <ChatEntryView key={entry.id} entry={entry} />
            ))}
          </div>

          {(commandError || (snapshot?.status === 'failed' && !commandError)) && (
            <div className="chat-command-error">
              <span>{commandError ?? 'The last turn failed.'}</span>
              {snapshot?.status === 'failed' && (
                <button type="button" onClick={() => void run(chat.retry)}>
                  Retry
                </button>
              )}
            </div>
          )}

          {snapshot && snapshot.status !== 'unavailable' && snapshot.entries.length > 0 && (
            <form className="chat-composer" onSubmit={submit}>
              <textarea
                aria-label="Chat message"
                maxLength={16 * 1024}
                placeholder="Ask about the review…"
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
              {busy ? (
                <button
                  type="button"
                  disabled={snapshot.status === 'interrupting'}
                  onClick={() => void run(chat.interrupt)}
                >
                  {snapshot.status === 'interrupting' ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button type="submit" disabled={!message.trim()}>
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
        <span>{entry.status === 'running' ? 'Working' : 'Activity'}</span>
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
