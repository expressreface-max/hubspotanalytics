import { NextResponse } from "next/server"
import { generateText } from "ai"
import { getActiveToken } from "@/lib/token-store"
import { pickAnalysisModel } from "@/lib/ai-model"
import { costUsd } from "@/lib/ai-cost"
import {
  searchAllDeals,
  dealAmount,
  fetchOwnerMap,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const DAY = 24 * 60 * 60 * 1000
const QUIET_DAYS = 14 // no logged contact in this many days = communication gap
const STALE_DAYS = 60 // quote older than this = aging / at risk

type ScanDeal = {
  dealId: string
  dealName: string
  rep: string
  amount: number
  ageDays: number | null
  daysSinceContact: number | null
  flags: string[]
  urgency: number
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

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  try {
    const now = Date.now()
    const filterGroups = [
      {
        filters: [
          { propertyName: "dealstage", operator: "IN", values: [...QUOTED_STAGE_IDS] },
          { propertyName: "pipeline", operator: "EQ", value: "default" },
        ],
      },
    ]
    const props = [...DEAL_PROPERTIES, "notes_last_contacted"]
    const [dealsRaw, ownerMap] = await Promise.all([
      searchAllDeals(token, filterGroups, props, 60),
      fetchOwnerMap(token),
    ])
    const deals = dealsRaw.filter((d) => {
      const name = (d.properties.dealname || "").toLowerCase()
      return !name.includes("doug schubert") && !name.includes("training")
    })

    // Build per-deal signals + deterministic flags (always useful, even if the
    // AI narrative is rate-limited).
    const scan: ScanDeal[] = deals.map((d) => {
      const p = d.properties
      const qt = quotedTime(d)
      const ageDays = qt == null ? null : Math.max(0, Math.round((now - qt) / DAY))
      const contactMs = parseTime(p.notes_last_contacted)
      const daysSinceContact = contactMs == null ? null : Math.max(0, Math.round((now - contactMs) / DAY))
      const amount = dealAmount(d)
      const rep = p.hubspot_owner_id ? ownerMap[p.hubspot_owner_id] || `Owner ${p.hubspot_owner_id}` : "Unassigned"
      const flags: string[] = []
      if (daysSinceContact == null) flags.push("No contact logged")
      else if (daysSinceContact >= QUIET_DAYS) flags.push(`No contact in ${daysSinceContact}d`)
      if (ageDays != null && ageDays >= 91) flags.push("Stale 91+d")
      else if (ageDays != null && ageDays >= STALE_DAYS) flags.push(`Aging ${ageDays}d`)
      // Urgency score: staleness + silence, lightly weighted by deal size.
      const silence = daysSinceContact ?? ageDays ?? 0
      const urgency = (ageDays ?? 0) + silence + Math.min(amount / 5000, 20)
      return {
        dealId: d.id,
        dealName: p.dealname || `Deal ${d.id}`,
        rep,
        amount,
        ageDays,
        daysSinceContact,
        flags,
        urgency,
      }
    })
    scan.sort((a, b) => b.urgency - a.urgency)

    const totalAmount = scan.reduce((s, d) => s + d.amount, 0)
    const flaggedCount = scan.filter((d) => d.flags.length > 0).length
    const noContactCount = scan.filter((d) => d.daysSinceContact == null || d.daysSinceContact >= QUIET_DAYS).length

    // Compact portfolio table for the model — no per-deal engagement fetch.
    const table = scan
      .map(
        (d) =>
          `- ${d.dealName} | rep: ${d.rep} | $${d.amount.toLocaleString()} | ` +
          `${d.ageDays == null ? "age n/a" : `${d.ageDays}d in quoted`} | ` +
          `${d.daysSinceContact == null ? "NO logged contact" : `last contact ${d.daysSinceContact}d ago`}` +
          `${d.flags.length ? ` | flags: ${d.flags.join(", ")}` : ""}`,
      )
      .join("\n")

    const system =
      "You are a sales operations analyst for Express Reface, a kitchen cabinet refacing and countertop company. " +
      "You are triaging the ENTIRE portfolio of open sales quotes to help a sales manager decide where to focus today. " +
      "Be specific, name the deals and reps, and be concise. No filler. " +
      "Respond in GitHub-flavored Markdown using EXACTLY these level-2 headings in this order:\n" +
      "## Executive summary\n" +
      "2-3 sentences on the overall health of the open pipeline and the single most important thing to do today.\n" +
      "## Urgent action items\n" +
      "A numbered list (most urgent first, at most 8) of specific deals that need action now. For each: the deal name, the rep, why it's urgent, and the one concrete next action.\n" +
      "## Communication gaps\n" +
      "A bullet list of deals that have gone quiet or have no logged contact, grouped by rep where helpful, with how long they've been silent. If none, say so."

    const prompt =
      `Here are all ${scan.length} currently-open quotes (Express Reface pipeline). ` +
      `A quote is "stale" past ${STALE_DAYS} days and a "communication gap" is no logged contact in ${QUIET_DAYS}+ days.\n\n` +
      `${table || "There are no open quotes."}\n`

    const { model, label, isPaid } = pickAnalysisModel()
    const { text, usage } = await generateText({
      model,
      system,
      prompt,
      maxOutputTokens: 1400,
      maxRetries: 2,
    })

    const inputTokens = usage?.inputTokens ?? 0
    const outputTokens = usage?.outputTokens ?? 0

    return NextResponse.json({
      scannedAt: new Date(now).toISOString(),
      dealCount: scan.length,
      flaggedCount,
      noContactCount,
      totalAmount,
      model: label,
      isPaid,
      usage: {
        inputTokens,
        outputTokens,
        // Cost of the tokens actually used, at Gemini 2.5 Flash paid rates.
        costUsd: costUsd(inputTokens, outputTokens),
      },
      urgent: scan.slice(0, 25),
      summaryMarkdown: text,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const raw = (err as Error).message || "Scan failed."
    const friendly = /api key not valid|invalid api key|api_key_invalid|permission denied/i.test(raw)
      ? "The Google API key is missing or invalid. Add a valid GOOGLE_GENERATIVE_AI_API_KEY in Project settings → Vars to run Gemini."
      : /rate-limit|rate limit|free tier|paid credits|upgrade|quota/i.test(raw)
        ? "AI scan was rate-limited on the free AI Gateway. Add a Google API key (GOOGLE_GENERATIVE_AI_API_KEY) in Project settings → Vars to use the paid Gemini model, or try again in a minute."
        : raw
    return NextResponse.json({ error: friendly }, { status: 500 })
  }
}
