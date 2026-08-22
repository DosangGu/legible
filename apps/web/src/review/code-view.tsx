import { Compartment, EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, WidgetType, gutter } from '@codemirror/view'
import { useEffect, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DiffAnchor, RenderModel } from './render-model.js'
import { sameAnchor } from './render-model.js'

export type ScrollRequest = {
  line: number
  nonce: number
}

export type InlineWidget = {
  id: string
  anchor: DiffAnchor
  content: ReactNode
}

export type AnchorRange = { start: DiffAnchor; end: DiffAnchor }

export function CodeView({
  model,
  selectedAnchor,
  selectedRange,
  onAnchorSelect,
  scrollRequest,
  inlineWidgets = [],
}: {
  model: RenderModel
  selectedAnchor?: DiffAnchor | undefined
  selectedRange?: AnchorRange | undefined
  onAnchorSelect: (anchor: DiffAnchor, extend: boolean) => void
  scrollRequest?: ScrollRequest | undefined
  inlineWidgets?: InlineWidget[] | undefined
}) {
  const parent = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const selection = useRef(new Compartment())
  const widgets = useRef(new Compartment())
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
          anchorGutter('LEFT', model, (anchor, extend) =>
            onAnchorSelectRef.current(anchor, extend),
          ),
          anchorGutter('RIGHT', model, (anchor, extend) =>
            onAnchorSelectRef.current(anchor, extend),
          ),
          selection.current.of([]),
          widgets.current.of([]),
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
      effects: widgets.current.reconfigure(inlineDecorations(model, inlineWidgets)),
    })
  }, [inlineWidgets, model])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: selection.current.reconfigure(
        selectionDecoration(
          model,
          selectedRange ??
            (selectedAnchor ? { start: selectedAnchor, end: selectedAnchor } : undefined),
        ),
      ),
    })
  }, [model, selectedAnchor, selectedRange])

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
    readonly onSelect: (anchor: DiffAnchor, extend: boolean) => void,
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
      this.onSelect(this.anchor, event.shiftKey)
    })
    return button
  }
}

function anchorGutter(
  side: 'LEFT' | 'RIGHT',
  model: RenderModel,
  onSelect: (anchor: DiffAnchor, extend: boolean) => void,
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

const widgetRoots = new WeakMap<HTMLElement, Root>()

class ReactInlineWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly content: ReactNode,
  ) {
    super()
  }

  override toDOM(): HTMLElement {
    const container = document.createElement('div')
    container.className = 'cm-inline-comment-widget'
    const root = createRoot(container)
    widgetRoots.set(container, root)
    root.render(this.content)
    return container
  }

  override updateDOM(dom: HTMLElement): boolean {
    const root = widgetRoots.get(dom)
    if (!root) return false
    root.render(this.content)
    return true
  }

  override destroy(dom: HTMLElement): void {
    const root = widgetRoots.get(dom)
    widgetRoots.delete(dom)
    queueMicrotask(() => root?.unmount())
  }
}

function inlineDecorations(model: RenderModel, widgets: InlineWidget[]): Extension {
  const documentLines = model.document.split('\n')
  const lineEnds: number[] = []
  let position = 0
  documentLines.forEach((line, index) => {
    position += line.length
    lineEnds.push(position)
    if (index < documentLines.length - 1) position += 1
  })
  const ranges: Range<Decoration>[] = []
  widgets.forEach((widget, index) => {
    const lineIndex = model.lines.findIndex(
      (line) =>
        sameAnchor(line.leftAnchor, widget.anchor) || sameAnchor(line.rightAnchor, widget.anchor),
    )
    const lineEnd = lineEnds[lineIndex]
    if (lineIndex < 0 || lineEnd === undefined) return
    ranges.push(
      Decoration.widget({
        widget: new ReactInlineWidget(widget.id, widget.content),
        block: true,
        side: 100 + index,
      }).range(lineEnd),
    )
  })
  return EditorView.decorations.of(Decoration.set(ranges, true))
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

function selectionDecoration(model: RenderModel, range: AnchorRange | undefined): Extension {
  if (!range) return []
  return EditorView.decorations.of((view) => {
    const ranges: Range<Decoration>[] = []
    model.lines.forEach((line, index) => {
      if (
        index + 1 <= view.state.doc.lines &&
        (anchorInRange(line.leftAnchor, range) || anchorInRange(line.rightAnchor, range))
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

function anchorInRange(anchor: DiffAnchor | undefined, range: AnchorRange): boolean {
  return (
    anchor !== undefined &&
    anchor.path === range.start.path &&
    anchor.side === range.start.side &&
    anchor.rangeKey === range.start.rangeKey &&
    anchor.line >= range.start.line &&
    anchor.line <= range.end.line
  )
}
