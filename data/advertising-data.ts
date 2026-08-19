// Static monthly advertising P&L spend by category ("Kitchens Now P&L").
// Sourced from the uploaded P&L spreadsheet (data/Advertising-887ea2.xlsx),
// Jan 2023 through May 2026. Serves as the fallback seed for the DB-backed
// advertising_spend table. Values are USD per month.
//
// Three categories only: Digital, Television, Print. (The spreadsheet's tiny
// "Other" category is intentionally excluded per product decision.)

export type AdSpendRow = {
  month: string // "YYYY-MM"
  digital: number
  television: number
  print: number
}

export const ADVERTISING_DATA: AdSpendRow[] = [
  { month: "2023-01", digital: 11813.97, television: 28531.98, print: 0 },
  { month: "2023-02", digital: 6056.29, television: 26778.36, print: 0 },
  { month: "2023-03", digital: 8809.31, television: 29340.98, print: 25560 },
  { month: "2023-04", digital: 6152.53, television: 30953, print: 25560 },
  { month: "2023-05", digital: 15198.68, television: 24239, print: 25560 },
  { month: "2023-06", digital: 12311.29, television: 33516.2, print: 42952.7 },
  { month: "2023-07", digital: 11895.23, television: 31863, print: 40720.41 },
  { month: "2023-08", digital: 11139.34, television: 29126, print: 20680.07 },
  { month: "2023-09", digital: 10678.5, television: 28454.65, print: 18046 },
  { month: "2023-10", digital: 10579.09, television: 32607.38, print: 12060 },
  { month: "2023-11", digital: 7660.97, television: 30029.85, print: 12060 },
  { month: "2023-12", digital: 5586.2, television: 27724, print: 12060 },
  { month: "2024-01", digital: 6174.68, television: 24421, print: 12060 },
  { month: "2024-02", digital: 9728.79, television: 30952, print: 15907 },
  { month: "2024-03", digital: 13369.79, television: 33294, print: 36997 },
  { month: "2024-04", digital: 8986.01, television: 42899.01, print: 36997 },
  { month: "2024-05", digital: 4736.29, television: 39140.01, print: 36997 },
  { month: "2024-06", digital: 12625.8, television: 42361.98, print: 36997 },
  { month: "2024-07", digital: 14683.25, television: 20570, print: 36997 },
  { month: "2024-08", digital: 17363.9, television: 43157, print: 36997 },
  { month: "2024-09", digital: 18826.52, television: 49694.39, print: 36997 },
  { month: "2024-10", digital: 18896.17, television: 48643.69, print: 44570.5 },
  { month: "2024-11", digital: 22366.05, television: 75110.25, print: 496.99 },
  { month: "2024-12", digital: 16943, television: 54610.25, print: 36856.99 },
  { month: "2025-01", digital: 21856.15, television: 41188.56, print: 26197 },
  { month: "2025-02", digital: 44318.6, television: 41058.5, print: 35975.3 },
  { month: "2025-03", digital: 42986.17, television: 34811.25, print: 26100 },
  { month: "2025-04", digital: 27277.66, television: 29770.75, print: 26100 },
  { month: "2025-05", digital: 21917.72, television: 30165, print: 26100 },
  { month: "2025-06", digital: 27496.11, television: 30994.92, print: 26100 },
  { month: "2025-07", digital: 39879.75, television: 27634.5, print: 26100 },
  { month: "2025-08", digital: 61722.74, television: 29341.75, print: 26100 },
  { month: "2025-09", digital: 57767.01, television: 27202.62, print: 57125 },
  { month: "2025-10", digital: 56709.34, television: 24600, print: 31025 },
  { month: "2025-11", digital: 49450.35, television: 10725, print: 31025 },
  { month: "2025-12", digital: 44617.3, television: 33973, print: 0 },
  { month: "2026-01", digital: 40897.23, television: 23500, print: 13300 },
  { month: "2026-02", digital: 43488.44, television: 8425, print: 13300 },
  { month: "2026-03", digital: 53407.59, television: 28350.01, print: 13300 },
  { month: "2026-04", digital: 89222.47, television: 30400, print: 5945 },
  { month: "2026-05", digital: 59678.39, television: 21650, print: 5945 },
]

export type AdChannelKey = "digital" | "television" | "print"

// Order + brand colors match the screenshot: Digital = orange, Television =
// blue, Print = green. Chart tokens: chart-1 orange, chart-2 blue, chart-4 green.
export const AD_CHANNELS: {
  key: AdChannelKey
  label: string
  color: string
}[] = [
  { key: "digital", label: "Digital", color: "var(--chart-1)" },
  { key: "television", label: "Television", color: "var(--chart-2)" },
  { key: "print", label: "Print", color: "var(--chart-3)" },
]
