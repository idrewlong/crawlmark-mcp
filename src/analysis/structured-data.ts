import type { JsonLdBlock } from "./hygiene-parse.js";

/**
 * Basic JSON-LD validation: a small table of required properties per type. This is not
 * Google's Rich Results Test. A "a|b" entry means at least one of the alternatives.
 */
export const REQUIRED_PROPERTIES: Record<string, string[]> = {
  Organization: ["name"],
  LocalBusiness: ["name", "address"],
  Product: ["name", "offers|review|aggregateRating"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
};

/** Article has no required properties in Google's docs; these are recommended, so a gap is only low severity. */
export const RECOMMENDED_PROPERTIES: Record<string, string[]> = {
  Article: ["headline", "author", "datePublished"],
};
const ARTICLE_SUBTYPES = ["BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report"];

/** schema.org subtypes of LocalBusiness (they inherit its requirements). Not exhaustive. */
const LOCAL_BUSINESS_SUBTYPES = [
  "AnimalShelter", "AutomotiveBusiness", "AutoBodyShop", "AutoDealer", "AutoPartsStore", "AutoRental", "AutoRepair", "AutoWash", "GasStation", "MotorcycleDealer", "MotorcycleRepair",
  "ChildCare", "Dentist", "DryCleaningOrLaundry", "EmergencyService", "FireStation", "Hospital", "PoliceStation", "EmploymentAgency", "EntertainmentBusiness", "AmusementPark", "ArtGallery", "Casino", "ComedyClub", "MovieTheater", "NightClub",
  "FinancialService", "AccountingService", "AutomatedTeller", "BankOrCreditUnion", "InsuranceAgency",
  "FoodEstablishment", "Bakery", "BarOrPub", "Brewery", "CafeOrCoffeeShop", "Distillery", "FastFoodRestaurant", "IceCreamShop", "Restaurant", "Winery",
  "GovernmentOffice", "HealthAndBeautyBusiness", "BeautySalon", "DaySpa", "HairSalon", "HealthClub", "NailSalon", "TattooParlor",
  "HomeAndConstructionBusiness", "Electrician", "GeneralContractor", "HVACBusiness", "HousePainter", "Locksmith", "MovingCompany", "Plumber", "RoofingContractor",
  "InternetCafe", "LegalService", "Attorney", "Notary", "Library",
  "LodgingBusiness", "BedAndBreakfast", "Campground", "Hostel", "Hotel", "Motel", "Resort", "VacationRental",
  "MedicalBusiness", "MedicalClinic", "Optician", "Pharmacy", "Physician", "ProfessionalService", "RadioStation", "RealEstateAgent", "RecyclingCenter", "SelfStorage", "ShoppingCenter",
  "SportsActivityLocation", "BowlingAlley", "ExerciseGym", "GolfCourse", "PublicSwimmingPool", "SkiResort", "TennisComplex",
  "Store", "BikeStore", "BookStore", "ClothingStore", "ComputerStore", "ConvenienceStore", "DepartmentStore", "ElectronicsStore", "Florist", "FurnitureStore", "GardenStore", "GroceryStore", "HardwareStore", "HobbyShop", "HomeGoodsStore", "JewelryStore", "LiquorStore", "MensClothingStore", "MobilePhoneStore", "MusicStore", "OfficeEquipmentStore", "OutletStore", "PawnShop", "PetStore", "ShoeStore", "SportingGoodsStore", "TireShop", "ToyStore", "WholesaleStore",
  "TelevisionStation", "TouristInformationCenter", "TravelAgency",
];

const ORGANIZATION_SUBTYPES = ["Corporation", "NGO", "OnlineBusiness", "EducationalOrganization", "School", "CollegeOrUniversity", "SportsOrganization", "GovernmentOrganization"];

/** The table entry that applies to a @type, or undefined if it isn't validated. */
export function requirementsFor(type: string): { canonical: string; required: string[] } | undefined {
  const t = type.replace(/^https?:\/\/schema\.org\//, "");
  if (REQUIRED_PROPERTIES[t]) return { canonical: t, required: REQUIRED_PROPERTIES[t]! };
  if (LOCAL_BUSINESS_SUBTYPES.includes(t)) return { canonical: "LocalBusiness", required: REQUIRED_PROPERTIES.LocalBusiness! };
  if (ORGANIZATION_SUBTYPES.includes(t)) return { canonical: "Organization", required: REQUIRED_PROPERTIES.Organization! };
  return undefined;
}

const present = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(present);
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
};

/** Top-level nodes: the objects in the block, plus everything in any @graph. */
function nodesOf(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const v of value) nodesOf(v, out);
  } else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o["@type"] !== undefined) out.push(o);
    if (o["@graph"]) nodesOf(o["@graph"], out);
  }
  return out;
}

export interface SchemaIssue {
  kind: "parse-error" | "missing-property" | "missing-recommended";
  /** The @type that was checked (missing-property only). */
  type?: string;
  /** Missing properties (missing-property) or the parser message (parse-error). */
  detail: string[];
}

export interface SchemaResult {
  blocks: number;
  types: string[];
  issues: SchemaIssue[];
}

export function validateJsonLd(blocks: JsonLdBlock[]): SchemaResult {
  const issues: SchemaIssue[] = [];
  const types = new Set<string>();
  for (const b of blocks) {
    if (!b.ok) {
      issues.push({ kind: "parse-error", detail: [b.error] });
      continue;
    }
    for (const node of nodesOf(b.value)) {
      const raw = node["@type"];
      for (const t of (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string")) {
        types.add(t);
        const tt = t.replace(/^https?:\/\/schema\.org\//, "");
        const recKey = RECOMMENDED_PROPERTIES[tt] ? tt : ARTICLE_SUBTYPES.includes(tt) ? "Article" : undefined;
        if (recKey) {
          const gap = RECOMMENDED_PROPERTIES[recKey]!.filter((prop) => !present(node[prop]));
          if (gap.length) issues.push({ kind: "missing-recommended", type: t, detail: gap });
          continue;
        }
        const req = requirementsFor(t);
        if (!req) continue;
        const missing = req.required.filter((prop) => !prop.split("|").some((alt) => present(node[alt])));
        if (missing.length) issues.push({ kind: "missing-property", type: t, detail: missing });
      }
    }
  }
  return { blocks: blocks.length, types: [...types].sort(), issues };
}
