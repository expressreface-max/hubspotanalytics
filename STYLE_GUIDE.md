# HS Analytics — Internal App Style Guide

> **Living document.** This is the shared visual language for our internal
> analytics/admin apps. Tokens live in `app/globals.css` (the source of truth);
> this file explains how to use them. When we change a convention, update
> **both** `globals.css` and this guide in the same commit.

Stack: **Next.js (App Router) · Tailwind CSS v4 · shadcn/ui · Geist Sans + Geist Mono**

---

## 1. Foundations

### Fonts

- **Sans (UI/body):** Geist Sans → use `font-sans` (default on `<body>`).
- **Mono (all numbers):** Geist Mono → use `font-mono` or the `.num` utility.
- Base font size is **14px**; tables/controls drop to ~13px.
- Configured via `next/font` in `app/layout.tsx` (`--font-inter`,
  `--font-jetbrains-mono`) and mapped in the `@theme inline` block.

### Color tokens (use the token, never raw hex)

| Token | Light | Role |
| --- | --- | --- |
| `background` | `#f4f5f8` gray-blue | page background |
| `foreground` | `#1a1d24` | primary text |
| `card` | white | cards, headers, popovers |
| `primary` | **HubSpot orange `#f05a00`** | accent, active nav, focus ring, chart-1 |
| `muted-foreground` | `#7e8694` | helper/secondary text, axis labels |
| `border` | `#dde1e8` | hairlines, inputs |
| `destructive` | `#e03131` | errors, delete |

- **Sidebar is clean white** (`#ffffff`) in light mode with slate text, a subtle
  gray hover (`--sidebar-accent`), and a hairline divider border. The active item
  uses the orange `--sidebar-primary`. In dark mode it matches the dark surface
  (`#1b2030`) so it sits flush with the rest of the UI. Driven by `--sidebar-*`.
- Dark mode flips backgrounds to navy-charcoal (`#141820` page, `#1b2030` card)
  while keeping the same orange accent.

### Chart palette

`--chart-1..5` = orange, blue, green, amber, purple. Helper tokens:
`--color-prior` (near-black YoY comparison line), `--color-grid` (gridlines),
`--color-axis` (tick labels). Reference them as `var(--chart-1)`,
`var(--color-grid)`, etc.

### Radius

`--radius: 0.5rem`. Scale: `lg` = cards, `md` = buttons/inputs/badges, `sm` =
small accents. Keep it tight and SaaS-like.

---

## 2. Layout

- **App shell:** fixed white sidebar (`w-56`) + scrollable main content.
- **Page header:** `px-6 py-5 border-b border-border bg-card`, flex row with
  title block on the left and controls (date range, filters) on the right.
  - Title: `text-xl font-bold`. Subtitle: `text-xs text-muted-foreground`.
- **Page body:** `p-6` with `gap-6` vertical rhythm.
- **KPI grid:** 4-up on desktop, 2-up ≤1024px, 1-up ≤640px.
- **Chart grid:** 2-up on desktop, 1-up ≤1024px.

---

## 3. Components

### Cards

`rounded-lg border bg-card shadow-sm`. Card titles are **small**
(`text-sm font-semibold`), not the shadcn 2xl default.

### KPI card

Label (`text-xs uppercase tracking-wide text-muted-foreground`) + value
(`.num text-2xl font-bold`, mono tabular, with `.animate-count`) + optional hint.
Icon chip on the right: `size-9 rounded-lg bg-primary/10 text-primary`.

### Numbers

**Every numeric value** (KPI values, table cells, deltas) uses mono tabular
figures via the `.num` utility. Right-align numeric table columns. Deltas use
`.delta-pos` / `.delta-neg` / `.delta-neu`.

### Sidebar nav items

- Active: `bg-primary/10 text-primary`.
- Inactive: `text-muted-foreground hover:text-foreground hover:bg-accent`.
- A connection status dot (green = connected, amber = pending) sits near the top.

### Controls

Compact `h-8`, `text-xs/13px`, `rounded-md` selects and search inputs. Focus =
orange ring (`ring`).

### Badges

Pill (`rounded-full text-[0.6875rem]`). Default badge is orange-tinted
(`bg-primary/10 text-primary`). Conversion-rate badges: green (high) / amber
(medium) / red (low).

---

## 4. Formatting helpers

```ts
// Currency, no cents → "$15,407"
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
// Compact for charts → "$400k"
v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`
// Percentage → "62%"
`${Math.round((num / den) * 100)}%`
```

---

## 5. Utility classes (in `globals.css`)

- `.num` — mono + tabular-nums for any numeric value.
- `.delta-pos` / `.delta-neg` / `.delta-neu` — trend colors.
- `.animate-count` — subtle fade/rise entrance for KPI values.
- Thin 6px webkit scrollbars are applied globally.

---

## Changelog

- **v1.2** — Sidebar changed from dark navy to clean white (slate text, gray
  hover, hairline border, orange active item) in light mode; in dark mode it now
  matches the dark surface instead of forcing navy.
- **v1.1** — Switched typography to the Geist family (Geist Sans for UI/body,
  Geist Mono for numbers/`.num`). Token names are now `--font-geist-sans` /
  `--font-geist-mono`.
- **v1** — Initial system: HubSpot orange primary, gray-blue canvas, permanent
  navy sidebar, Inter + JetBrains Mono, 0.5rem radius, chart palette + helper
  tokens, KPI/`.num` conventions. Adapted from the HS Analytics CSS reference to
  Tailwind v4 / oklch.
