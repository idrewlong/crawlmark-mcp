# Semrush fixtures

Copied from the documented examples in `docs/research/semrush-api.md` (Semrush developer docs, accessed
2026-10-13). No real API call was made. Header text, column order, number formats and the commas inside the
Trends (`Td`) value are verbatim; real domains are replaced with `example.com` / `example.org` / `example.net`,
and the examples' brand keywords with `example widgets` / `examplebook`.

| File | Source |
|---|---|
| `phrase_these.doc.csv` | the documented phrase_these response (Ph, Nq, Cp, Co, Nr; the doc's request also asked for Td, which its response omits) |
| `domain_organic.doc.csv` | the documented domain_organic response (first three lines) |
| `domain_organic_organic.doc.csv` | the documented domain_organic_organic response (first two lines) |
| `backlinks_overview.doc.csv` | the documented v3 backlinks_overview response, trimmed to the three columns crawlmark uses |
| `v4-backlinks-overview.json` | the documented v4 backlinks overview response (excerpt) |
| `v4-error-403.json` | the documented v4 JSON error body |
| `phrase_these.csv`, `domain_organic.csv`, `domain_organic_organic.csv` | what crawlmark's own requests return: the documented header text for exactly the columns it sends (`export_columns`), with invented values. `domain_organic.csv` uses CRLF line ends, an `export_escape`-style quoted field and a position of 0 (not ranked) |
| `error-50.txt`, `error-120.txt`, `error-132.txt` | documented v3 error bodies |
| `balance.txt` | the documented countapiunits body (`1,000`) |

A test checks every CSV header cell against the code-to-header tables in the research note.
