import { NextResponse } from "next/server"
import { generateText } from "ai"
import { getActiveToken } from "@/lib/token-store"
import { pickAnalysisModel } from "@/lib/ai-model"
import { buildDealContext, buildTranscript } from "@/lib/deal-context"
import { HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = { dealId?: string }

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const { dealId }: Body = await req.json().catch(() => ({}))
  if (!dealId) return NextResponse.json({ error: "dealId is required" }, { status: 400 })

  try {
    const ctx = await buildDealContext(token, dealId)
    const transcript = buildTranscript(ctx.engagements)

    const system =
      "You are a sales operations analyst for Express Reface, a kitchen cabinet refacing and countertop company. " +
      "You review an open sales quote and its full communication history, then produce a concise, actionable briefing for the sales rep. " +
      "Be specific and reference what actually happened in the communications. If information is missing, say so plainly. No filler. " +
      "Respond in GitHub-flavored Markdown using EXACTLY these level-2 headings in this order:\n" +
      "## Summary\n" +
      "A 2-3 sentence plain-language summary of where this deal stands.\n" +
      "## Communication history\n" +
      "What has actually happened across the emails, calls, meetings and notes — key moments, who reached out, and how the customer responded. If nothing is logged, say so.\n" +
      "## Deal sentiment\n" +
      "One line: Hot / Warm / Cold / At risk, followed by a short justification.\n" +
      "## Risks & blockers\n" +
      "A bullet list of what could stall or lose this deal (e.g. gone quiet, pricing, competitor, unanswered questions). If none, say so.\n" +
      "## Recommended next steps\n" +
      "A numbered list of 2-4 concrete actions the rep can take this week, each with a one-line rationale.\n" +
      "## Suggested outreach message\n" +
      "A short, ready-to-send message (email or text) the rep can use to move the deal forward, tailored to the communication history."

    const prompt =
      `Analyze this open quote and its communication history.\n\n` +
      `=== DEAL ===\n${ctx.dealContextText}\n\n` +
      `=== COMMUNICATION HISTORY (oldest to newest${ctx.totalEngagements > ctx.engagements.length ? `, showing ${ctx.engagements.length} most recent of ${ctx.totalEngagements}` : ""}) ===\n` +
      `${transcript || "No logged communications were found for this deal."}\n`

    const { model } = pickAnalysisModel()
    const { text } = await generateText({
      model,
      system,
      prompt,
      maxOutputTokens: 1600,
      maxRetries: 2,
    })

    return NextResponse.json({
      deal: {
        id: ctx.deal.id,
        name: ctx.deal.name,
        stage: ctx.deal.stage,
        pipeline: ctx.deal.pipeline,
        amount: ctx.deal.amount,
        ownerName: ctx.deal.ownerName,
        ageDays: ctx.deal.ageDays,
      },
      engagementCounts: ctx.counts,
      totalEngagements: ctx.totalEngagements,
      analysisText: text,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const raw = (err as Error).message || "Analysis failed."
    // Surface the common model-provider limits as a clear, actionable message.
    const friendly = /api key not valid|invalid api key|api_key_invalid|permission denied/i.test(raw)
      ? "The Google API key is missing or invalid. Add a valid GOOGLE_GENERATIVE_AI_API_KEY in Project settings → Vars to run Gemini."
      : /rate-limit|rate limit|free tier|paid credits|upgrade|quota/i.test(raw)
        ? "AI analysis was rate-limited on the free AI Gateway. Add a Google API key (GOOGLE_GENERATIVE_AI_API_KEY) in Project settings → Vars to use the paid Gemini model, or try again in a minute."
        : raw
    return NextResponse.json({ error: friendly }, { status: 500 })
  }
}
