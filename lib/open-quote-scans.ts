import "server-only"
import { generateText } from "ai"
import { sql } from "@/lib/db"
import { pickAnalysisModel } from "@/lib/ai-model"
import { costUsd } from "@/lib/ai-cost"
import { buildDealContext, buildTranscript, fetchStageLabelMap, type DealContext } from "@/lib/deal-context"
import {
  searchAllDeals,
  dealAmount,
  fetchOwnerMap,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  type HubSpotDeal,
} from "@/lib/hubspot"

const DAY = 24 * 60 * 60 * 1000

export type OpenQuoteBasics = {
  dealId: string
  dealName: string
  rep: string
  stage: string
  amount: number
  ageDays: number | null
  daysSinceContact: number | null
}

export type StoredScan = {
  dealId: string
  scanDate: string
  scanType: "baseline" | "update"
  dealName: string | null
  rep: string | null
  stage: string | null
  amount: number | null
  ageDays: number | null
  daysSinceContact: number | null
  engagementCount: number
  lastEngagementAt: string | null
  changesDetected: boolean
  markdown: string
  model: string | null
  createdAt: string
}

function parseTime(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function quotedTime(deal: HubSpotDeal): number | null {
  let min: number | null = null
  for (const prop of QUOTED_DATE_PROPS) {
    const t = parseTime(deal.properties[prop])
    if (t != null && (min == null || t < min)) min = t
  }
  return min
}

// Every deal currently sitting in a Quoted stage of the Express Reface pipeline.
export async function fetchOpenQuoteDeals(token: string): Promise<OpenQuoteBasics[]> {
  const now = Date.now()
  const filterGroups = [
    {
      filters: [
        { propertyName: "dealstage", operator: "IN", values: [...QUOTED_STAGE_IDS] },
        { propertyName: "pipeline", operator: "EQ", value: "default" },
      ],
    },
  ]
  const props = [...DEAL_PROPERTIES, "notes_last_contacted", "dealstage"]
  const [dealsRaw, ownerMap, stageLabels] = await Promise.all([
    searchAllDeals(token, filterGroups, props, 60),
    fetchOwnerMap(token),
    fetchStageLabelMap(token),
  ])
  return dealsRaw
    .filter((d) => {
      const name = (d.properties.dealname || "").toLowerCase()
      return !name.includes("doug schubert") && !name.includes("training")
    })
    .map((d) => {
      const p = d.properties
      const qt = quotedTime(d)
      const contactMs = parseTime(p.notes_last_contacted)
      const rep = p.hubspot_owner_id ? ownerMap[p.hubspot_owner_id] || `Owner ${p.hubspot_owner_id}` : "Unassigned"
      return {
        dealId: d.id,
        dealName: p.dealname || `Deal ${d.id}`,
        rep,
        stage: stageLabels[p.dealstage || ""] || p.dealstage || "—",
        amount: dealAmount(d),
        ageDays: qt == null ? null : Math.max(0, Math.round((now - qt) / DAY)),
        daysSinceContact: contactMs == null ? null : Math.max(0, Math.round((now - contactMs) / DAY)),
      }
    })
}

function rowToScan(r: any): StoredScan {
  return {
    dealId: r.deal_id,
    scanDate: typeof r.scan_date === "string" ? r.scan_date : new Date(r.scan_date).toISOString().slice(0, 10),
    scanType: r.scan_type,
    dealName: r.deal_name,
    rep: r.rep,
    stage: r.stage,
    amount: r.amount == null ? null : Number(r.amount),
    ageDays: r.age_days,
    daysSinceContact: r.days_since_contact,
    engagementCount: r.engagement_count,
    lastEngagementAt: r.last_engagement_at ? new Date(r.last_engagement_at).toISOString() : null,
    changesDetected: r.changes_detected,
    markdown: r.markdown,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

async function getLatestScan(dealId: string): Promise<StoredScan | null> {
  const rows = await sql`
    select * from open_quote_scans
    where deal_id = ${dealId}
    order by created_at desc
    limit 1
  `
  return rows.length ? rowToScan(rows[0]) : null
}

export async function getScanHistory(dealId: string, limit = 30): Promise<StoredScan[]> {
  const rows = await sql`
    select * from open_quote_scans
    where deal_id = ${dealId}
    order by created_at desc
    limit ${limit}
  `
  return rows.map(rowToScan)
}

// --- Structured "deal state" derived from a stored scan's markdown ----------
// The scan prompt always uses fixed level-2 headings, so we can extract every
// framework field deterministically for the list view + management summary
// without a second AI call. The full markdown is still shown in the expand.

export type DealHealth = "Green" | "Yellow" | "Red"

export type DealState = {
  health: DealHealth | null
  probability: number | null // 0-100
  clearNextStep: boolean | null
  managementAttention: boolean
  managementReason: string
  summary: string
  nextAction: string
  coaching: string
  scanType: "baseline" | "update"
  scanDate: string
  changesDetected: boolean
}

function sectionBody(md: string, heading: RegExp): string {
  const lines = md.split("\n")
  let capturing = false
  const buf: string[] = []
  for (const line of lines) {
    if (/^\s*##\s+/.test(line)) {
      if (capturing) break
      capturing = heading.test(line.replace(/^\s*##\s+/, ""))
      continue
    }
    if (capturing) buf.push(line)
  }
  return buf.join("\n").trim()
}

function clean(s: string): string {
  return s
    .replace(/^[-*\d.)\s]+/, "") // strip a leading bullet / list marker
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function firstSentence(s: string, max = 200): string {
  const c = clean(s)
  if (!c) return ""
  const m = c.match(/^(.*?[.!?])(\s|$)/)
  let out = m ? m[1] : c
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + "…"
  return out
}

// Up to two sentences, capped, for the list summary line.
function firstTwoSentences(s: string, max = 220): string {
  const c = clean(s)
  if (!c) return ""
  const m = c.match(/^(.*?[.!?]\s+.*?[.!?])(\s|$)/)
  let out = m ? m[1] : c
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + "…"
  return out
}

function parseHealth(body: string): DealHealth | null {
  const m = clean(body).match(/\b(green|yellow|red)\b/i)
  if (!m) return null
  const w = m[1].toLowerCase()
  return ((w[0].toUpperCase() + w.slice(1)) as DealHealth)
}

function parsePercent(body: string): number | null {
  // Do NOT run clean() here — it strips leading digits, which would eat the
  // "30" in "30%". Match on the whitespace-normalized raw body instead.
  const m = body.replace(/\s+/g, " ").match(/(\d{1,3})\s*%/)
  if (!m) return null
  const n = Number(m[1])
  return n >= 0 && n <= 100 ? n : null
}

function parseYesNo(body: string): boolean | null {
  const m = clean(body).match(/^\s*\W*\s*(yes|no)\b/i)
  if (!m) return null
  return m[1].toLowerCase() === "yes"
}

export function extractDealState(
  markdown: string,
): Pick<
  DealState,
  "health" | "probability" | "clearNextStep" | "managementAttention" | "managementReason" | "summary" | "nextAction" | "coaching"
> {
  const summaryBody = sectionBody(markdown, /^summary/i)
  const healthBody = sectionBody(markdown, /deal health|^health/i)
  const health = parseHealth(healthBody)
  const probability = parsePercent(sectionBody(markdown, /probability/i))
  const clearNextStep = parseYesNo(sectionBody(markdown, /clear next step/i))
  const nextAction = firstSentence(sectionBody(markdown, /recommended next action|next action|recommended next steps|action items/i), 180)
  const coaching = firstSentence(sectionBody(markdown, /coaching/i), 220)

  const mgmtBody = sectionBody(markdown, /management attention|management/i)
  const mgmtYes = parseYesNo(mgmtBody)
  const managementAttention = mgmtYes === true
  const managementReason = managementAttention
    ? firstSentence(mgmtBody.replace(/^\s*\W*\s*yes[\s.:,–—-]*/i, ""), 180)
    : ""

  // List summary prefers the dedicated Summary section; older update-format
  // scans have no Summary heading, so fall back to their What-changed section,
  // then the health note, then the first non-heading text of the markdown.
  const stripped = markdown.replace(/^\s*#{1,6}.*$/gm, "").trim()
  const summary = firstTwoSentences(
    summaryBody || sectionBody(markdown, /what changed/i) || healthBody || stripped,
  )

  return { health, probability, clearNextStep, managementAttention, managementReason, summary, nextAction, coaching }
}

// Latest deal state for every scanned open quote, keyed by deal id — one cheap
// DB read, used to score each row in the list + build the management summary.
export async function getScanStates(): Promise<Record<string, DealState>> {
  const rows = await sql`
    select distinct on (deal_id)
      deal_id, scan_type, scan_date, changes_detected, markdown
    from open_quote_scans
    order by deal_id, created_at desc
  `
  const out: Record<string, DealState> = {}
  for (const r of rows) {
    const scanType = r.scan_type as "baseline" | "update"
    const fields = extractDealState(r.markdown)
    out[r.deal_id] = {
      ...fields,
      scanType,
      scanDate:
        typeof r.scan_date === "string" ? r.scan_date : new Date(r.scan_date).toISOString().slice(0, 10),
      changesDetected: r.changes_detected,
    }
  }
  return out
}

export async function getScanSummary(): Promise<{
  dealsScanned: number
  lastScanAt: string | null
  scannedToday: number
  changedToday: number
}> {
  const [a] = await sql`
    select count(distinct deal_id)::int as deals, max(created_at) as last
    from open_quote_scans
  `
  const [b] = await sql`
    select count(*)::int as today,
           count(*) filter (where changes_detected)::int as changed
    from open_quote_scans
    where scan_date = current_date
  `
  return {
    dealsScanned: a?.deals ?? 0,
    lastScanAt: a?.last ? new Date(a.last).toISOString() : null,
    scannedToday: b?.today ?? 0,
    changedToday: b?.changed ?? 0,
  }
}

// Human-readable "what changed" block comparing a fresh context to the last scan.
function buildChangesBlock(ctx: DealContext, quote: OpenQuoteBasics, last: StoredScan): { text: string; changed: boolean } {
  const newEngagements = Math.max(0, ctx.totalEngagements - (last.engagementCount ?? 0))
  const stageChanged = (last.stage ?? "") !== quote.stage
  const amountChanged = last.amount != null && Math.round(last.amount) !== Math.round(quote.amount)
  const sinceMs = last.lastEngagementAt ? Date.parse(last.lastEngagementAt) : null
  const newTranscript = buildTranscript(ctx.engagements, sinceMs)
  const changed = newEngagements > 0 || stageChanged || amountChanged || !!newTranscript

  const lines: string[] = []
  lines.push(`Last reviewed: ${last.scanDate} (${last.scanType}).`)
  lines.push(
    stageChanged
      ? `Stage: changed from "${last.stage}" to "${quote.stage}".`
      : `Stage: unchanged ("${quote.stage}").`,
  )
  if (amountChanged) lines.push(`Amount: changed from $${Math.round(last.amount!).toLocaleString()} to $${Math.round(quote.amount).toLocaleString()}.`)
  const hasUnreadable = ctx.unreadableChannels.length > 0
  if (newEngagements > 0) {
    lines.push(`New readable interactions since last review: ${newEngagements} (readable total now ${ctx.totalEngagements}).`)
  } else if (hasUnreadable) {
    const chans = ctx.unreadableChannels.map((u) => `${u.count} ${u.type}`).join(", ")
    lines.push(
      `No new READABLE interactions detected — but ${chans} on this deal cannot be read, so new email/other activity is NOT reflected here. Do NOT conclude the deal is idle from this line alone.`,
    )
  } else {
    lines.push(`No new logged interactions since last review (still ${ctx.totalEngagements} total).`)
  }
  lines.push(
    quote.daysSinceContact == null
      ? `No contact has ever been logged.`
      : `Days since last contact (HubSpot last-contacted field, which DOES include emails): ${quote.daysSinceContact}. Treat this as the reliable freshness signal${hasUnreadable ? " when interaction bodies are unreadable" : ""}.`,
  )
  const text =
    lines.join("\n") +
    (newTranscript ? `\n\n=== NEW COMMUNICATIONS SINCE LAST REVIEW (oldest to newest) ===\n${newTranscript}` : "")
  return { text, changed }
}

// Shared 10-field scoring framework used for every scan. Fixed level-2
// headings let us extract each field deterministically (the free model can't
// produce reliable structured JSON), while the whole thing still renders as a
// readable briefing in the expand panel.
const FRAMEWORK =
  "Respond in GitHub-flavored Markdown using EXACTLY these level-2 headings, in this order, each on its own line. " +
  "Be specific and cite what actually happened in the communications. No filler, no preamble.\n\n" +
  "## Summary\n" +
  "1-2 sentences in plain language: where this deal stands right now.\n" +
  "## Deal health\n" +
  "The FIRST word MUST be exactly Green, Yellow, or Red, then a short justification. Green = on track, Yellow = needs attention, Red = at risk of stalling or dying.\n" +
  "## Probability of closing\n" +
  "Start with a single percentage like 60%, then one line of rationale grounded in the evidence.\n" +
  "## Last meaningful contact\n" +
  "Describe the most recent substantive interaction (not an automated touch) and roughly how long ago it was.\n" +
  "## Clear next step\n" +
  "The FIRST word MUST be Yes or No — does the rep have a concrete, scheduled next step? Then state what it is, or that none is set.\n" +
  "## Customer commitments\n" +
  "Bullet list of important commitments the customer or rep has made (deposits, decisions, dates, approvals). Write 'None noted' if none.\n" +
  "## Objections & unresolved issues\n" +
  "Bullet list of objections, concerns, or open questions raised. Write 'None noted' if none.\n" +
  "## Unmet follow-ups\n" +
  "Bullet list of follow-ups that were promised but not yet completed, by the rep or the customer. Write 'None' if none.\n" +
  "## Recommended next action\n" +
  "ONE specific, concrete action to take next, with a one-line rationale.\n" +
  "## Coaching observation\n" +
  "One coaching note written FOR THE SALES MANAGER about how the rep is handling this deal — what to reinforce or correct.\n" +
  "## Management attention\n" +
  "The FIRST word MUST be Yes or No — does this deal need manager intervention right now? If Yes, give a one-line reason; if No, write 'No.'"

const BASELINE_SYSTEM =
  "You are a sales operations analyst for Express Reface, a kitchen cabinet refacing and countertop company. " +
  "This is the FIRST review of an open sales quote. Score the deal against the framework below for the sales manager and rep.\n\n" +
  FRAMEWORK

const UPDATE_SYSTEM =
  "You are a sales operations analyst for Express Reface, a kitchen cabinet refacing and countertop company. " +
  "You are doing a DAILY re-score of an open quote you have reviewed before. You are given your PREVIOUS review and a summary of what has changed since then. " +
  "Re-score the deal against the framework below, letting any new developments move the health, probability, and next action. Do not simply copy the previous review — reconsider it against the current evidence. " +
  "In the Summary, lead with what changed since the last review. Only call the deal idle/stalled when the evidence actually supports it: if some channels (e.g. emails) are unreadable, or the last-contacted date is recent, do NOT assume inactivity — say visibility is limited instead.\n\n" +
  FRAMEWORK

// Scan a single open quote: baseline on first sight, delta on subsequent days.
export async function scanDeal(
  token: string,
  quote: OpenQuoteBasics,
  model: ReturnType<typeof pickAnalysisModel>["model"],
  modelId: string,
  stageLabels?: Record<string, string>,
): Promise<{ scanType: "baseline" | "update"; changesDetected: boolean; inputTokens: number; outputTokens: number }> {
  const ctx = await buildDealContext(token, quote.dealId, stageLabels)
  const last = await getLatestScan(quote.dealId)

  let scanType: "baseline" | "update"
  let changesDetected: boolean
  let system: string
  let prompt: string

  if (!last) {
    scanType = "baseline"
    changesDetected = true
    system = BASELINE_SYSTEM
    const transcript = buildTranscript(ctx.engagements)
    prompt =
      `Produce the baseline summary and evaluation for this open quote.\n\n` +
      `=== DEAL ===\n${ctx.dealContextText}\n\n` +
      `=== COMMUNICATION HISTORY (oldest to newest${ctx.totalEngagements > ctx.engagements.length ? `, showing ${ctx.engagements.length} most recent of ${ctx.totalEngagements}` : ""}) ===\n` +
      `${transcript || "No logged communications were found for this deal."}\n`
  } else {
    scanType = "update"
    const changes = buildChangesBlock(ctx, quote, last)
    changesDetected = changes.changed
    system = UPDATE_SYSTEM
    prompt =
      `Review the changes to this open quote since your last review and give the rep today's action items.\n\n` +
      `=== DEAL (current) ===\n${ctx.dealContextText}\n\n` +
      `=== YOUR PREVIOUS REVIEW (${last.scanDate}) ===\n${last.markdown}\n\n` +
      `=== WHAT CHANGED ===\n${changes.text}\n`
  }

  const { text, usage } = await generateText({ model, system, prompt, maxOutputTokens: 1800, maxRetries: 2 })
  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const lastEngIso = ctx.lastEngagementAt ? new Date(ctx.lastEngagementAt).toISOString() : null

  await sql`
    insert into open_quote_scans (
      deal_id, scan_date, scan_type, deal_name, rep, stage, amount, age_days,
      days_since_contact, engagement_count, last_engagement_at, changes_detected, markdown, model
    ) values (
      ${quote.dealId}, current_date, ${scanType}, ${quote.dealName}, ${quote.rep}, ${quote.stage},
      ${quote.amount}, ${quote.ageDays}, ${quote.daysSinceContact}, ${ctx.totalEngagements},
      ${lastEngIso}, ${changesDetected}, ${text}, ${modelId}
    )
    on conflict (deal_id, scan_date) do update set
      scan_type = excluded.scan_type,
      deal_name = excluded.deal_name,
      rep = excluded.rep,
      stage = excluded.stage,
      amount = excluded.amount,
      age_days = excluded.age_days,
      days_since_contact = excluded.days_since_contact,
      engagement_count = excluded.engagement_count,
      last_engagement_at = excluded.last_engagement_at,
      changes_detected = excluded.changes_detected,
      markdown = excluded.markdown,
      model = excluded.model,
      created_at = now()
  `

  return { scanType, changesDetected, inputTokens, outputTokens }
}

export type DailyScanResult = {
  scanned: number
  baselines: number
  updates: number
  changed: number
  skipped: number
  total: number
  model: string
  isPaid: boolean
  cost: { inputTokens: number; outputTokens: number; costUsd: number }
  timedOut: boolean
}

// Scan every open quote (or a single deal). Sequential to respect rate limits;
// stops starting new deals once the time budget is exhausted so a cron run
// never exceeds its function limit — remaining deals are picked up next run.
export async function runDailyScan(
  token: string,
  opts: { dealId?: string; budgetMs?: number } = {},
): Promise<DailyScanResult> {
  const { model, label: modelId, isPaid } = pickAnalysisModel()
  const budgetMs = opts.budgetMs ?? 250_000
  const started = Date.now()

  const allQuotes = await fetchOpenQuoteDeals(token)
  let quotes = opts.dealId ? allQuotes.filter((q) => q.dealId === opts.dealId) : allQuotes

  // For a full run, prioritize deals that have NOT yet been scanned today in
  // the current framework format. Without this, a timed-out run always restarts
  // from index 0 and re-scans the same first deals every time, so the tail of
  // the list never gets a summary. Deals already done today move to the end so
  // repeated runs make forward progress until every open quote is covered.
  if (!opts.dealId && quotes.length > 0) {
    const doneRows = await sql<{ deal_id: string }[]>`
      select distinct deal_id from open_quote_scans
      where scan_date = current_date and markdown ilike '%## Deal health%'
    `
    const doneToday = new Set(doneRows.map((r) => r.deal_id))
    quotes = [...quotes].sort((a, b) => Number(doneToday.has(a.dealId)) - Number(doneToday.has(b.dealId)))
  }

  const stageLabels = await fetchStageLabelMap(token)

  const result: DailyScanResult = {
    scanned: 0, baselines: 0, updates: 0, changed: 0, skipped: 0,
    total: quotes.length, model: modelId, isPaid,
    cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    timedOut: false,
  }

  for (let i = 0; i < quotes.length; i++) {
    if (!opts.dealId && Date.now() - started > budgetMs) {
      result.timedOut = true
      result.skipped = quotes.length - i
      break
    }
    try {
      const r = await scanDeal(token, quotes[i], model, modelId, stageLabels)
      result.scanned++
      if (r.scanType === "baseline") result.baselines++
      else result.updates++
      if (r.changesDetected) result.changed++
      result.cost.inputTokens += r.inputTokens
      result.cost.outputTokens += r.outputTokens
    } catch {
      result.skipped++
    }
    // Gentle pacing between deals to stay under API rate limits.
    if (i < quotes.length - 1 && !opts.dealId) await new Promise((r) => setTimeout(r, 400))
  }

  result.cost.costUsd = costUsd(result.cost.inputTokens, result.cost.outputTokens)
  return result
}
