import type React from "react"

// Lightweight Markdown renderer for the subset the deal-analysis prompt produces:
// ## headings, - / * bullets, 1. numbered lists, **bold**, and paragraphs.
export function AnalysisMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let key = 0

  const flushList = () => {
    if (!list) return
    const items = list.items
    if (list.ordered) {
      blocks.push(
        <ol key={key++} className="flex flex-col gap-1.5 pl-1">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-foreground">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">
                {i + 1}
              </span>
              <span>{inline(it)}</span>
            </li>
          ))}
        </ol>,
      )
    } else {
      blocks.push(
        <ul key={key++} className="flex flex-col gap-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-foreground">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              <span>{inline(it)}</span>
            </li>
          ))}
        </ul>,
      )
    }
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushList()
      continue
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/)
    if (heading) {
      flushList()
      blocks.push(
        <h3 key={key++} className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {inline(heading[1])}
        </h3>,
      )
      continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (ordered) {
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[1])
      continue
    }
    if (bullet) {
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
      continue
    }
    flushList()
    blocks.push(
      <p key={key++} className="text-sm leading-relaxed text-foreground">
        {inline(line)}
      </p>,
    )
  }
  flushList()

  return <div className="flex flex-col gap-2">{blocks}</div>
}

// Render **bold** inline segments; everything else is plain text.
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  )
}
