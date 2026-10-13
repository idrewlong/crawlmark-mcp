# Google discovery fixtures

Hand-written payloads in the shape of the real API responses used by client
discovery. All names are reserved example domains; never commit real ones.

- `sites-list.json`: `searchconsole.sites.list` (v1)
- `account-summaries.json`: `analyticsadmin.accountSummaries.list` (v1beta)
- `data-streams/<propertyId>.json`: `analyticsadmin.properties.dataStreams.list` (v1beta)

Cases covered: a host with both a domain property and a URL-prefix property,
http and https URL-prefix properties for one host, a subdomain property, an
unverified site, a host with two GA4 properties (the lower ID wins numerically),
a GA4-only host, and a GA4 property with only an app stream.

Tag Manager (Phase 6b):

- `gtm-accounts.json`: `tagmanager.accounts.list` (v2)
- `gtm-containers.json`: `accounts.containers.list` responses keyed by account ID. Covers a container with two domains (one a full URL), a web container with no domain list, a server container (skipped), and a second container for a host another container already claims.
- `../gtm/container-version.json`: a hand-built live container version (example IDs) for the gtm_audit rules.
