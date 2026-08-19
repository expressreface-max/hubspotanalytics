import "server-only"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { LanguageModel } from "ai"

/**
 * Picks the model for AI deal analysis.
 *
 * Preference order:
 *  1. Google Gemini via a direct Google API key (paid, no AI-Gateway free-tier
 *     rate limits) when GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) is set.
 *  2. openai/gpt-oss-120b on the Vercel AI Gateway free tier as a zero-config
 *     fallback (works without any key, but is requests-per-minute throttled).
 *
 * This lets the feature run out of the box and transparently upgrade to a paid
 * Gemini model as soon as the operator adds a Google API key in project Vars.
 */
export function pickAnalysisModel(): { model: LanguageModel; label: string; isPaid: boolean } {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY
  if (googleKey) {
    const google = createGoogleGenerativeAI({ apiKey: googleKey })
    return { model: google("gemini-2.5-flash"), label: "gemini-2.5-flash", isPaid: true }
  }
  return { model: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b", isPaid: false }
}
