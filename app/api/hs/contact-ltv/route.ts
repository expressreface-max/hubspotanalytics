import { NextResponse } from "next/server"
import {
  getToken,
  hsFetch,
  searchAllDeals,
  isClosedWon,
  dealAmount,
  sleep,
  HubSpotError,
} from "@/lib/hubspot"

export const maxDuration = 120

// Contact lifetime-value by monthly creation cohort.
//
// Model (as requested): build a universe of contacts by the MONTH they were
// created, then look FORWARD across all time to sum the won revenue generated
// by those contacts (regardless of when the deal actually closed). LTV per
// cohort month = total attributed revenue / contacts created that month.
//
// Revenue is attributed to a contact's creation month by walking each won deal
// back to its (primary) associated contact and using that contact's createdate.
// Deals with no associated contact, or whose contact was created before the
// start month, are excluded from the cohort revenue (so attributed revenue is
// necessarily <= all won revenue in the range).

const START = "2023-01" // first cohort month (inclusive)

// YYYY-MM (UTC) for an ISO date string, or null.
function monthKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

// All month keys from START through the current month, inclusive, ascending.
function monthsFrom(start: string): string[] {
  const [sy, sm] = start.split("-").map(Number)
  const now = new Date()
  const ey = now.getUTCFullYear()
  const em = now.getUTCMonth() + 1
  const out: string[] = []
  let y = sy
  let m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

// First instant of a YYYY-MM month, and of the following month (UTC).
function monthBounds(key: string): { start: string; next: string } {
  const [y, m] = key.split("-").map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString()
  const next = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString()
  return { start, next }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function POST() {
  const token = getToken()
  if (!token) {
    return NextResponse.json({ error: "HubSpot not configured" }, { status: 400 })
  }

  try {
    const startBound = monthBounds(START).start

    // 1. All won deals closed since the start month (amount + closedate only).
    const deals = await searchAllDeals(
      token,
      [
        {
          filters: [
            { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
            { propertyName: "closedate", operator: "GTE", value: startBound },
          ],
        },
      ],
      ["amount", "closedate", "hs_is_closed_won"],
      25,
    )
    const wonDeals = deals.filter(isClosedWon)
    const dealAmountById = new Map<string, number>()
    for (const d of wonDeals) dealAmountById.set(d.id, dealAmount(d))

    // 2. Walk each won deal back to its primary associated contact.
    const dealToContact = new Map<string, string>()
    for (const ids of chunk([...dealAmountById.keys()], 100)) {
      const data = await hsFetch<{
        results: { from: { id: string }; to: { toObjectId: number }[] }[]
      }>("/crm/v4/associations/deals/contacts/batch/read", {
        token,
        method: "POST",
        body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
      })
      for (const r of data.results || []) {
        const contactId = r.to?.[0]?.toObjectId
        if (contactId != null) dealToContact.set(r.from.id, String(contactId))
      }
      await sleep(150)
    }

    // 3. Read the createdate of every associated contact.
    const contactIds = [...new Set([...dealToContact.values()])]
    const contactCreated = new Map<string, string>()
    for (const ids of chunk(contactIds, 100)) {
      const data = await hsFetch<{
        results: { id: string; properties: Record<string, string | null> }[]
      }>("/crm/v3/objects/contacts/batch/read", {
        token,
        method: "POST",
        body: JSON.stringify({ properties: ["createdate"], inputs: ids.map((id) => ({ id })) }),
      })
      for (const c of data.results || []) {
        if (c.properties.createdate) contactCreated.set(c.id, c.properties.createdate)
      }
      await sleep(150)
    }

    // 4. Attribute each won deal's amount to its contact's creation month.
    const revenueByMonth = new Map<string, number>()
    const wonByMonth = new Map<string, number>()
    let attributedRevenue = 0
    let unattributed = 0
    for (const [dealId, amount] of dealAmountById) {
      const contactId = dealToContact.get(dealId)
      const created = contactId ? contactCreated.get(contactId) : null
      const key = monthKey(created)
      if (!key || key < START) {
        unattributed += amount
        continue
      }
      revenueByMonth.set(key, (revenueByMonth.get(key) || 0) + amount)
      wonByMonth.set(key, (wonByMonth.get(key) || 0) + 1)
      attributedRevenue += amount
    }

    // 5. Contacts created per cohort month (search total per month).
    const months = monthsFrom(START)
    const contactsByMonth = new Map<string, number>()
    for (const key of months) {
      const { start, next } = monthBounds(key)
      const data = await hsFetch<{ total: number }>("/crm/v3/objects/contacts/search", {
        token,
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: "createdate", operator: "GTE", value: start },
                { propertyName: "createdate", operator: "LT", value: next },
              ],
            },
          ],
          properties: ["createdate"],
          limit: 1,
        }),
      })
      contactsByMonth.set(key, data.total || 0)
      await sleep(220)
    }

    // 6. Assemble the monthly series.
    const rows = months.map((month) => {
      const contactsCreated = contactsByMonth.get(month) || 0
      const revenue = revenueByMonth.get(month) || 0
      const won = wonByMonth.get(month) || 0
      return {
        month,
        contactsCreated,
        revenue,
        wonDeals: won,
        ltv: contactsCreated > 0 ? revenue / contactsCreated : 0,
      }
    })

    const totalContacts = rows.reduce((s, r) => s + r.contactsCreated, 0)
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
    const totalWon = rows.reduce((s, r) => s + r.wonDeals, 0)

    return NextResponse.json({
      rows,
      totals: {
        contactsCreated: totalContacts,
        revenue: totalRevenue,
        wonDeals: totalWon,
        ltv: totalContacts > 0 ? totalRevenue / totalContacts : 0,
      },
      // Diagnostics: revenue from won deals whose contact was created before the
      // start month or that had no associated contact (excluded from cohorts).
      unattributedRevenue: unattributed,
      attributedRevenue,
      wonDealCount: wonDeals.length,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
