// Shape returned to the client for a deal's RealEstateAPI enrichment row,
// sourced from reapi_deal_enrichment (nightly cron / backfill) with a
// fallback to the legacy live per-request lookup (lib/realestate.ts) for
// deals the nightly cron hasn't reached yet.
export type DealDetailEnrichment = {
  source: "table" | "live" | null
  propertyDataAvailable: boolean
  ownerDataAvailable: boolean
  propertyError: string | null
  ownerError: string | null
  estimatedValue: number | null
  estimatedEquity: number | null
  equityPercent: number | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  ownerOccupied: boolean | null
  absenteeOwner: boolean | null
  vacant: boolean | null
  highEquity: boolean | null
  propertyType: string | null
  yearBuilt: number | null
  livingSquareFeet: number | null
  bedrooms: number | null
  bathrooms: number | null
  lotSquareFeet: number | null
  floodZone: boolean | null
  mlsActive: boolean | null
  mlsListingPrice: number | null
  mlsStatus: string | null
  ownerFullName: string | null
  ownerAge: number | null
  ownerGender: string | null
  ownerMaritalStatus: string | null
  ownerOccupation: string | null
  ownerEmails: string[]
  ownerPhones: string[]
  ownerDncAllPhones: boolean | null
  erTerritory: string | null
  erSubRegion: string | null
  erRegion: string | null
  fetchedAt: string | null
}

export function emptyDealEnrichment(): DealDetailEnrichment {
  return {
    source: null,
    propertyDataAvailable: false,
    ownerDataAvailable: false,
    propertyError: null,
    ownerError: null,
    estimatedValue: null,
    estimatedEquity: null,
    equityPercent: null,
    lastSaleDate: null,
    lastSalePrice: null,
    ownerOccupied: null,
    absenteeOwner: null,
    vacant: null,
    highEquity: null,
    propertyType: null,
    yearBuilt: null,
    livingSquareFeet: null,
    bedrooms: null,
    bathrooms: null,
    lotSquareFeet: null,
    floodZone: null,
    mlsActive: null,
    mlsListingPrice: null,
    mlsStatus: null,
    ownerFullName: null,
    ownerAge: null,
    ownerGender: null,
    ownerMaritalStatus: null,
    ownerOccupation: null,
    ownerEmails: [],
    ownerPhones: [],
    ownerDncAllPhones: null,
    erTerritory: null,
    erSubRegion: null,
    erRegion: null,
    fetchedAt: null,
  }
}
