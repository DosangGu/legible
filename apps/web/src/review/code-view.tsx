import { Compartment, EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view'
import { useEffect, useRef } from 'react'

import type { DiffAnchor, RenderModel } from './render-model.js'
import { sameAnchor } from './render-model.js'

export type ScrollRequest = {
  line: number
  nonce: number
}

export function CodeView({
  model,
  selectedAnchor,
  onAnchorSelect,
  scrollRequest,
}: {
  model: RenderModel
  selectedAnchor?: DiffAnchor | undefined
  onAnchorSelect: (anchor: DiffAnchor) => void
  scrollRequest?: ScrollRequest | undefined
}) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const selection = useRef(new Compartment())
  const onAnchorSelectRef = useRef(onAnchorSelect)

  useEffect(() => {
    onAnchorSelectRef.current = onAnchorSelect
  }, [onAnchorSelect])

  useEffect(() => {
    if (!parent.current) return
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: model.document,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'Review diff' }),
          lineDecorations(model),
          anchorGutter('LEFT', model, (anchor) => onAnchorSelectRef.current(anchor)),
          anchorGutter('RIGHT', model, (anchor) => onAnchorSelectRef.current(anchor)),
          selection.current.of([]),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { minWidth: 'max-content' },
          }),
        ],
      }),
    })
    // CodeMirror hides gutters because they normally duplicate document content.
    // These gutters contain interactive review anchors, so keep them exposed.
    const exposeAnchorGutters = () => {
      editor.dom
        .querySelectorAll('.cm-gutters[aria-hidden]')
        .forEach((element) => element.removeAttribute('aria-hidden'))
    }
    const gutterObserver = new MutationObserver(exposeAnchorGutters)
    gutterObserver.observe(editor.dom, {
      attributes: true,
      attributeFilter: ['aria-hidden'],
      childList: true,
      subtree: true,
    })
    exposeAnchorGutters()
    view.current = editor
    return () => {
      gutterObserver.disconnect()
      view.current = null
      editor.destroy()
    }
  }, [model])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: selection.current.reconfigure(selectionDecoration(model, selectedAnchor)),
    })
  }, [model, selectedAnchor])

  useEffect(() => {
    const editor = view.current
    if (!editor || !scrollRequest) return
    const line = Math.max(1, Math.min(scrollRequest.line, editor.state.doc.lines))
    editor.dispatch({
      effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'start' }),
    })
  }, [model, scrollRequest])

  return <div className="code-view" ref={parent} />
}

class AnchorMarker extends GutterMarker {
  constructor(
    readonly anchor: DiffAnchor,
    readonly onSelect: (anchor: DiffAnchor) => void,
  ) {
    super()
  }

  override toDOM(): Node {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'line-anchor'
    button.textContent = String(this.anchor.line)
    button.title = `Select ${this.anchor.side} line ${String(this.anchor.line)}`
    button.setAttribute('aria-label', button.title)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onSelect(this.anchor)
    })
    return button
  }
}

function anchorGutter(
  side: 'LEFT' | 'RIGHT',
  model: RenderModel,
  onSelect: (anchor: DiffAnchor) => void,
): Extension {
  return gutter({
    class: side === 'LEFT' ? 'cm-left-gutter' : 'cm-right-gutter',
    lineMarker(view, line) {
      const metadata = model.lines[view.state.doc.lineAt(line.from).number - 1]
      const anchor = side === 'LEFT' ? metadata?.leftAnchor : metadata?.rightAnchor
      return anchor ? new AnchorMarker(anchor, onSelect) : null
    },
  })
}

function lineDecorations(model: RenderModel): Extension {
  return EditorView.decorations.of((view) => {
    const ranges: Range<Decoration>[] = []
    model.lines.forEach((line, index) => {
      if (index + 1 > view.state.doc.lines) return
      const classes = [`cm-diff-${line.kind}`]
      if (line.changed) classes.push('cm-diff-whole-changed')
      ranges.push(
        Decoration.line({ attributes: { class: classes.join(' ') } }).range(
          view.state.doc.line(index + 1).from,
        ),
      )
    })
    return Decoration.set(ranges, true)
  })
}

function selectionDecoration(model: RenderModel, anchor: DiffAnchor | undefined): Extension {
  if (!anchor) return []
  return EditorView.decorations.of((view) => {
    const ranges: Range<Decoration>[] = []
    model.lines.forEach((line, index) => {
      if (
        index + 1 <= view.state.doc.lines &&
        (sameAnchor(line.leftAnchor, anchor) || sameAnchor(line.rightAnchor, anchor))
      ) {
        ranges.push(
          Decoration.line({ attributes: { class: 'cm-diff-selected' } }).range(
            view.state.doc.line(index + 1).from,
          ),
        )
      }
    })
    return Decoration.set(ranges)
  })
}
