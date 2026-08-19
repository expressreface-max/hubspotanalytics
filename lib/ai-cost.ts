// Cost model for AI deal scans. Rates are for Google Gemini 2.5 Flash on the
// paid tier (verified Aug 2026): $0.30 / 1M input tokens, $2.50 / 1M output
// tokens. When the free AI Gateway fallback model is used there is no per-token
// charge, so the estimate represents the paid-Gemini scenario the operator asked
// about ("use google api key to run the gemini model").
export const GEMINI_FLASH_INPUT_PER_1M = 0.3
export const GEMINI_FLASH_OUTPUT_PER_1M = 2.5

// Typical token footprint of ONE per-deal AI review (the full deal-analysis
// call: deal context + up to 40 capped engagements in, a ~6-section briefing
// out). Deliberately conservative so the projected cost is an upper bound.
export const EST_INPUT_TOKENS_PER_DEAL = 5000
export const EST_OUTPUT_TOKENS_PER_DEAL = 1000

// Dollar cost of a token split at the Gemini 2.5 Flash paid rates.
export function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * GEMINI_FLASH_INPUT_PER_1M +
    (outputTokens / 1_000_000) * GEMINI_FLASH_OUTPUT_PER_1M
  )
}

// Estimated cost of a single full per-deal AI review.
export function estCostPerDeal(): number {
  return costUsd(EST_INPUT_TOKENS_PER_DEAL, EST_OUTPUT_TOKENS_PER_DEAL)
}

// Estimated cost to scan every open deal once per day, plus the monthly run-rate.
export function estDailyScanCost(dealCount: number): { perDeal: number; daily: number; monthly: number } {
  const perDeal = estCostPerDeal()
  const daily = perDeal * dealCount
  return { perDeal, daily, monthly: daily * 30 }
}

// Format a small USD amount with enough precision to be meaningful.
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00"
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
