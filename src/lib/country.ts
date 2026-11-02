/**
 * Markets for Ahrefs and Semrush (Phase 9, spec 9.1 "Market"). Pure.
 *
 * A client's country is its clients.yaml `country` (ISO 3166-1 alpha-2, stored
 * uppercase), else the country of a country-level DataForSEO `locationCode`.
 * DataForSEO country location codes are 2000 + the ISO 3166-1 numeric code
 * (2840 = United States, 840; 2826 = United Kingdom, 826). City and region codes
 * are larger and have no country here, so Ahrefs and Semrush are unavailable for a
 * client that has one and no `country`.
 */
import { cliHint } from "./cli-hint.js";

/** ISO 3166-1 numeric code -> alpha-2. */
const ISO_NUMERIC_TO_ALPHA2: Readonly<Record<number, string>> = {
  4: "AF", 8: "AL", 10: "AQ", 12: "DZ", 16: "AS", 20: "AD", 24: "AO", 28: "AG", 31: "AZ", 32: "AR",
  36: "AU", 40: "AT", 44: "BS", 48: "BH", 50: "BD", 51: "AM", 52: "BB", 56: "BE", 60: "BM", 64: "BT",
  68: "BO", 70: "BA", 72: "BW", 76: "BR", 84: "BZ", 90: "SB", 92: "VG", 96: "BN", 100: "BG", 104: "MM",
  108: "BI", 112: "BY", 116: "KH", 120: "CM", 124: "CA", 132: "CV", 136: "KY", 140: "CF", 144: "LK", 148: "TD",
  152: "CL", 156: "CN", 158: "TW", 170: "CO", 174: "KM", 175: "YT", 178: "CG", 180: "CD", 184: "CK", 188: "CR",
  191: "HR", 192: "CU", 196: "CY", 203: "CZ", 204: "BJ", 208: "DK", 212: "DM", 214: "DO", 218: "EC", 222: "SV",
  226: "GQ", 231: "ET", 232: "ER", 233: "EE", 234: "FO", 242: "FJ", 246: "FI", 250: "FR", 254: "GF", 258: "PF",
  262: "DJ", 266: "GA", 268: "GE", 270: "GM", 275: "PS", 276: "DE", 288: "GH", 292: "GI", 296: "KI", 300: "GR",
  304: "GL", 308: "GD", 312: "GP", 316: "GU", 320: "GT", 324: "GN", 328: "GY", 332: "HT", 336: "VA", 340: "HN",
  344: "HK", 348: "HU", 352: "IS", 356: "IN", 360: "ID", 364: "IR", 368: "IQ", 372: "IE", 376: "IL", 380: "IT",
  384: "CI", 388: "JM", 392: "JP", 398: "KZ", 400: "JO", 404: "KE", 408: "KP", 410: "KR", 414: "KW", 417: "KG",
  418: "LA", 422: "LB", 426: "LS", 428: "LV", 430: "LR", 434: "LY", 438: "LI", 440: "LT", 442: "LU", 446: "MO",
  450: "MG", 454: "MW", 458: "MY", 462: "MV", 466: "ML", 470: "MT", 474: "MQ", 478: "MR", 480: "MU", 484: "MX",
  492: "MC", 496: "MN", 498: "MD", 499: "ME", 500: "MS", 504: "MA", 508: "MZ", 512: "OM", 516: "NA", 520: "NR",
  524: "NP", 528: "NL", 531: "CW", 533: "AW", 534: "SX", 540: "NC", 548: "VU", 554: "NZ", 558: "NI", 562: "NE",
  566: "NG", 570: "NU", 578: "NO", 580: "MP", 583: "FM", 584: "MH", 585: "PW", 586: "PK", 591: "PA", 598: "PG",
  600: "PY", 604: "PE", 608: "PH", 616: "PL", 620: "PT", 624: "GW", 626: "TL", 630: "PR", 634: "QA", 638: "RE",
  642: "RO", 643: "RU", 646: "RW", 659: "KN", 660: "AI", 662: "LC", 670: "VC", 674: "SM", 678: "ST", 682: "SA",
  686: "SN", 688: "RS", 690: "SC", 694: "SL", 702: "SG", 703: "SK", 704: "VN", 705: "SI", 706: "SO", 710: "ZA",
  716: "ZW", 724: "ES", 728: "SS", 729: "SD", 740: "SR", 748: "SZ", 752: "SE", 756: "CH", 760: "SY", 762: "TJ",
  764: "TH", 768: "TG", 776: "TO", 780: "TT", 784: "AE", 788: "TN", 792: "TR", 795: "TM", 796: "TC", 798: "TV",
  800: "UG", 804: "UA", 807: "MK", 818: "EG", 826: "GB", 834: "TZ", 840: "US", 850: "VI", 854: "BF", 858: "UY",
  860: "UZ", 862: "VE", 882: "WS", 887: "YE", 894: "ZM",
};

/** The country (alpha-2, uppercase) of a country-level DataForSEO location code, else null (a city or region code). */
export function countryFromLocationCode(locationCode: number): string | null {
  if (!Number.isInteger(locationCode) || locationCode <= 2000 || locationCode >= 3000) return null;
  return ISO_NUMERIC_TO_ALPHA2[locationCode - 2000] ?? null;
}

/** A client's market: its `country` override (uppercased), else the country of its location code, else null. */
export function resolveCountry(country: string | undefined, locationCode: number): string | null {
  const c = country?.trim().toUpperCase();
  return c ? c : countryFromLocationCode(locationCode);
}

/** Ahrefs `country`: a lowercase alpha-2 enum; crawlmark sends `gb` (not `uk`) for the United Kingdom (ahrefs-api-v3.md). */
export function ahrefsCountry(cc: string): string {
  return cc.trim().toLowerCase();
}

/** The message when a client has no country Ahrefs/Semrush can use (spec 9.1). */
export function noCountryMessage(client: { domain: string; locationCode: number }): string {
  return (
    `Set country: XX for ${client.domain} in clients.yaml (or ${cliHint()} clients set ${client.domain} --country XX); ` +
    `Ahrefs/Semrush need a country, and locationCode ${client.locationCode} is not a country.`
  );
}
