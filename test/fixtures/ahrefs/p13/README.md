# Ahrefs fixtures for Phase 13 B

Hand-built from the response schemas in Ahrefs' published OpenAPI file for Site Explorer (`https://docs.ahrefs.com/reference/site-explorer.json`, accessed 2026-10-13): top-level keys (`metrics`, `keywords`, `refdomains`, `domain_ratings`, `competitors`) and field names are the documented ones; values are invented for example.com and placeholder competitors. `organic-competitors-full.json` has a null domain and a domain with a zero-width space escape (both handled by the mapper).

Site Audit (`https://docs.ahrefs.com/reference/site-audit.json`): `site-audit-projects.json` (`healthscores`), `site-audit-issues.json` (`issues`, one name carrying markup and one with `crawled: 0`), `site-audit-page-explorer.json` (`pages`).
