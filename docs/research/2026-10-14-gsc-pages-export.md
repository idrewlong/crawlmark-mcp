# Search Console Pages report export: format

Date: 2026-10-14. For `import_index_report` and `crawlmark-cli index-coverage import`.

## Question

What does Search Console's Pages (Page indexing) report export contain, so crawlmark can import it locally and show Google's full counts per reason, which the API doesn't offer (it only has per-URL inspection)?

## Findings

**Formats (Google docs).** Search Console exports a report's data from the export button: "You can choose among several download formats (currently Google Sheets, Microsoft Excel, and CSV)" ([Export data directly from a Search Console report](https://support.google.com/webmasters/answer/12919797)). The Page indexing report help says "Both chart and table data are exported" and "Values shown as either ~ or - in the report (not available/not a number) will be zeros in the downloaded data" ([Page indexing report](https://support.google.com/webmasters/answer/7440203)).

**Zip of CSVs, tabs in a workbook (Google blog).** "If you choose Google Sheets or Excel you'll get a spreadsheet with two tabs, and if you choose to download as csv, you'll get a zip file with two csv files." Exports from "a specific drill-down view" include "the details describing this view in the exported file", and the file's title "includes the domain name, the report, and the date of the export" ([More and better data export in Search Console, 2020](https://developers.google.com/search/blog/2020/02/data-export)).

**Row limits (Google docs).** "Data is truncated to 1,000 rows of representative examples of your data. Totals shown are actual totals, not totals with any row limits applied." The report's examples table "is limited to 1,000 rows" (both pages above). So a reason's count is complete, but its URL list is a sample of at most 1,000.

**Reasons (Google docs).** Why pages aren't indexed: Server error (5xx); Redirect error; URL blocked by robots.txt; URL marked 'noindex'; Soft 404; Blocked due to unauthorized request (401); Not found (404); Blocked due to access forbidden (403); URL blocked due to other 4xx issue; Crawled - currently not indexed; Discovered - currently not indexed; Alternate page with proper canonical tag; Duplicate without user-selected canonical; Duplicate, Google chose different canonical than user; Page with redirect. Indexed with a problem: Indexed, though blocked by robots.txt; Page indexed without content ([Page indexing report](https://support.google.com/webmasters/answer/7440203)).

**File and column names (observed in real exports, not documented by Google).** Open-source parsers written against real downloads agree on:

- Summary zip (`<host>-Coverage-<YYYY-MM-DD>.zip`): `Chart.csv` (Date, Not indexed, Indexed, Impressions), `Critical issues.csv` and `Non-critical issues.csv` (Reason, Source, Validation, Pages), `Metadata.csv` (two columns, Property and Value). Sources: [oleg-koval/agent-skills summarize_gsc_coverage.py](https://github.com/oleg-koval/agent-skills/blob/main/plugins/olko-web-ops/skills/search-console-indexing-audit/scripts/summarize_gsc_coverage.py), [TokenBrice/pharos-watch analyze-gsc-coverage.mjs](https://github.com/TokenBrice/pharos-watch/blob/main/scripts/maintenance/analyze-gsc-coverage.mjs), [vidluther/pardonned analyze-gsc.ts](https://github.com/vidluther/pardonned/blob/main/scripts/analyze-gsc.ts).
- A reason's drilldown: `Table.csv` (URL, Last crawled), with its own `Chart.csv` and `Metadata.csv` (same sources). An older single-CSV drilldown, "`https___clojurians-log.clojureverse.org_ Index Coverage Drilldown 2019-09-17.csv`", has the same two columns with dates like `20 Aug 2019` ([gist](https://gist.github.com/plexus/90d310374bcdf234bfe4ea5cfb84da1d)).

## Not confirmed

1. Which tab Google calls "Critical issues" in the current UI. The parsers treat it as "Why pages aren't indexed" and "Non-critical issues" as "Improve page experience"; crawlmark matches each row against Google's reason list first and uses the file name only for unknown reasons.
2. The exact Metadata rows of a drilldown (which key names the reason). crawlmark looks for any value that is a known reason, and otherwise asks for `--reason` / `reason`.
3. The Last crawled date format in other UI languages. crawlmark reads ISO dates, `20 Aug 2019`, `Aug 20, 2019` and Excel serial dates, and otherwise keeps the cleaned text.
4. Whether .xlsx tab names match the CSV names exactly. Tables are recognised by their header row, so the names only break ties.

## Decision

- Import `.zip` of CSVs, a single `.csv` (or tab-separated text), and `.xlsx` (Excel, or Google Sheets downloaded as .xlsx), parsed locally with no new dependency: a bounded zip reader on `node:zlib` (stored and deflate entries; encrypted entries and Zip64 refused; each entry inflated with `maxOutputLength` set to its declared size, so a zip bomb fails before allocation) and an indexOf-based SpreadsheetML reader (cached values only; formulas never evaluated). The old binary `.xls` is refused with "export as CSV or Excel".
- Recognise tables by header: Reason + Pages (reasons), URL (drilldown), Date + Indexed / Not indexed (chart), two columns (metadata).
- Export date from the file name, then the metadata, then the chart's last day, then the import day (with a note). Host from the file name (or metadata) must belong to the client's Search Console property; drilldown URLs outside the property are dropped, and an export with none inside is refused.
- Untrusted content: control and invisible characters stripped, cells capped at 2,000 characters, labels at 200 with leading `= + - @` removed, 5,000 rows per table, 50 columns, 20 tables, 25 MB per file; 200 example URLs stored per reason.
- Merge with URL Inspection: the export is complete per reason as of its date; an example URL inspected after the export day shows whether Google indexes it now ("indexed now").
