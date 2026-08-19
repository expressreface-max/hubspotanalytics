// Owner-occupied household counts per territory, used to compute market
// penetration (jobs won ÷ households) on the Funnel page.
//
// NOTE: This is a static, editable dataset. It is intended to be migrated to a
// `territory_households` table in Supabase later; until then, edit the numbers
// here. Keys must match the HubSpot `er_territory` value exactly.
export const TERRITORY_HOUSEHOLDS: Record<string, number> = {
  "Folsom / El Dorado Hills / Orangevale": 51081,
  "Sacramento / Elk Grove / Florin": 77930,
  "Roseville / Antelope / Foothill Farms": 57242,
  "Davis / Dixon / Elmira": 17187,
  "Arden-Arcade / Elk Grove / Sacramento": 52506,
  "Rancho Cordova / Carmichael / Fair Oaks": 47621,
  "Citrus Heights / North Highlands": 30363,
  "Vacaville / Fairfield / Suisun City": 55061,
  "Lodi / Galt / Dogtown": 28822,
  "Lincoln / Rocklin / Auburn": 51315,
  "Napa / Winters": 23953,
  "Sacramento / Woodland / West Sacramento": 92724,
}

export function householdsFor(territory: string): number | null {
  return TERRITORY_HOUSEHOLDS[territory] ?? null
}
