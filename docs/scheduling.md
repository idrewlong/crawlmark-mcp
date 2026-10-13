# Scheduled audits and alerts

`crawlmark-cli audit`, `crawlmark-cli check-traffic`, `crawlmark-cli check-ranks` and `crawlmark-cli report` are meant for cron or another scheduler. The MCP server stays stateless; these commands are separate runs that print JSON to stdout. The [README](../README.md#scheduled-audits-and-alerts) has the summary.

## What each command does

- **`audit`** runs a fresh `run_audit` for each client, one after another (each audit launches Chrome), saves the snapshot and diffs it against that client's previous audit. A client's first audit is saved as the baseline and raises no alerts. `--all` runs discovery first, so new domains are included. `--urls a,b` overrides the page list for one client. The on-page check inside the audit is the only paid call (DataForSEO, per `DATAFORSEO_BASE_URL`; the sandbox by default).
- **`check-traffic`** compares the last 7 complete Search Console days (ending 3 days ago, because Search Console lags) with the 7 days before, split into branded and non-branded with the same matching as the monthly report. It uses Search Console only, so it is free. Clients without a Search Console property are skipped.
- **`check-ranks`** saves each tracked keyword's Search Console average position over the last 7 complete days (free) to rank history, which `rank_history` and the `rank_trend` report section read. Running it twice on the same day keeps one row per keyword. Clients with no tracked keywords are skipped, and so are clients with no Search Console property unless `--live` is given.
- **`check-ranks --live`** also checks each tracked keyword's live Google rank through DataForSEO (paid, about $0.002 a keyword). It runs only when `--live` is on the command line. Every live check is fetched fresh (not from the one-day SERP cache), so each run is billed. Each client's total is checked against its monthly cap (and the global one) before its first request; a client over its cap, or without DataForSEO, is listed under `skipped` with the reason and the others still run. `--dry-run` prints each client's keywords, the estimate and what's left of the cap, and calls nothing. Weekly is plenty.
- **Skipping.** A client that is ignored, has no Search Console property (for `check-traffic`) or fails with an error is listed under `skipped` and never fails the run. Only when every client that was tried fails, or an explicit `--client` can't be found, does the run count as an error.
- **`--dry-run`** lists what would run and calls nothing but discovery.
- **`audit --include-tag-manager`** also audits each client's Tag Manager container and adds its findings. They are medium or low, so they never raise an alert. Without the flag, Tag Manager is left out (and earlier Tag Manager findings show as `unverified` in the diff, never `resolved`).
- **`report`** writes report files (Markdown, HTML, PDF, Word) from a template, data only, one client at a time. See [Report files](#report-files) below.

## Alerts

| Alert | When |
|---|---|
| New finding | Any `critical` or `high` finding in this audit that the previous audit did not have |
| Traffic drop | Non-branded clicks down by at least `ALERT_TRAFFIC_DROP_PCT` (default 25) **and** at least `ALERT_MIN_CLICKS_LOST` (default 50) clicks |
| Rank drop | `check-ranks --live` only: a tracked keyword that was in the top 10 at its last live check and is now outside it, one that fell at least `ALERT_RANK_DROP` places (default 5), or one that was found and no longer is. Search Console averages never alert |

Output is `{ command, ranAt, dryRun, results, alerts, skipped, errors, webhook, exitCode, discovery }`. If `ALERT_WEBHOOK_URL` is set and there are alerts, a short text summary is POSTed to it as `{ "text": "..." }` (Slack-style incoming webhook). It must be `https`. Nothing is sent when there are no alerts.

| Exit code | Meaning |
|---|---|
| 0 | Ran; no alerts |
| 1 | Error: bad usage, unknown `--client`, every client failed, discovery failed with no clients left to run, or alerts could not be delivered to the webhook |
| 2 | Ran; one or more alerts |

If discovery fails but `clients.yaml` has entries, those clients still run: the failure is listed in `errors` but the exit code stays 0 or 2.

Scheduled jobs usually run in `service_account` mode (no browser sign-in). Use absolute paths, since schedulers have a minimal environment, and build first with `npm run build`.

## cron

Weekdays at 06:00 for traffic, Mondays at 05:00 for audits. Replace `/usr/local/bin/node` with the output of `which node`. stdout (JSON) and stderr (diagnostics) go to separate files so the `.json` log stays valid JSON:

```cron
0 6 * * 1-5  cd /path/to/crawlmark-mcp && /usr/local/bin/node --disable-warning=ExperimentalWarning dist/cli.js check-traffic --all >> /var/log/crawlmark-traffic.json 2>> /var/log/crawlmark-traffic.err
0 5 * * 1    cd /path/to/crawlmark-mcp && /usr/local/bin/node --disable-warning=ExperimentalWarning dist/cli.js audit --all >> /var/log/crawlmark-audit.json 2>> /var/log/crawlmark-audit.err
30 6 * * *   cd /path/to/crawlmark-mcp && /usr/local/bin/node --disable-warning=ExperimentalWarning dist/cli.js check-ranks --all >> /var/log/crawlmark-ranks.json 2>> /var/log/crawlmark-ranks.err
# Paid, opt-in: live ranks once a week (only because --live is given).
0 7 * * 1    cd /path/to/crawlmark-mcp && /usr/local/bin/node --disable-warning=ExperimentalWarning dist/cli.js check-ranks --all --live >> /var/log/crawlmark-ranks.json 2>> /var/log/crawlmark-ranks.err
```

Appended runs make a stream of JSON objects, not one array; read it with `jq -s`, or write to a dated file per run.

## macOS launchd

Save as `~/Library/LaunchAgents/com.example.crawlmark-traffic.plist`, then `launchctl load` it. Node is at `/opt/homebrew/bin/node` on Apple Silicon with Homebrew and `/usr/local/bin/node` on Intel (check with `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.crawlmark-traffic</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>/path/to/crawlmark-mcp/dist/cli.js</string>
    <string>check-traffic</string>
    <string>--all</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/crawlmark-mcp</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/crawlmark-traffic.out.json</string>
  <key>StandardErrorPath</key><string>/tmp/crawlmark-traffic.err.log</string>
</dict>
</plist>
```

## GitHub Actions

Keep the service-account JSON key (`GOOGLE_SERVICE_ACCOUNT_JSON`) and the webhook URL in repository secrets. The runner has no `config/clients.yaml` (it is gitignored), so store its content in a secret and write it out in the job, as below, or commit a non-secret copy and point `CLIENTS_FILE` at it. `DATA_DIR` holds the saved audits and the spend ledger, so the `audit` job restores and saves it with `actions/cache`; otherwise there is nothing to diff against:

```yaml
name: crawlmark
on:
  schedule: [{ cron: "0 6 * * 1-5" }]
  workflow_dispatch:
jobs:
  traffic:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: |
          mkdir -p secrets config
          echo "$GOOGLE_SERVICE_ACCOUNT_JSON" > secrets/google-service-account.json
          echo "$CLIENTS_YAML" > config/clients.yaml
          node --disable-warning=ExperimentalWarning dist/cli.js check-traffic --all
        env:
          GOOGLE_AUTH_MODE: service_account
          GOOGLE_APPLICATION_CREDENTIALS: ./secrets/google-service-account.json
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          CLIENTS_YAML: ${{ secrets.CLIENTS_YAML }}
          ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/cache@v4
        with:
          path: data
          key: crawlmark-data-${{ github.run_id }}
          restore-keys: crawlmark-data-
      - run: npm ci && npm run build
      - run: |
          mkdir -p secrets config
          echo "$GOOGLE_SERVICE_ACCOUNT_JSON" > secrets/google-service-account.json
          echo "$CLIENTS_YAML" > config/clients.yaml
          node --disable-warning=ExperimentalWarning dist/cli.js audit --all
        env:
          GOOGLE_AUTH_MODE: service_account
          GOOGLE_APPLICATION_CREDENTIALS: ./secrets/google-service-account.json
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          CLIENTS_YAML: ${{ secrets.CLIENTS_YAML }}
          ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}
```

The `schedule` above runs both jobs daily; for weekly audits use a second workflow with its own `cron`. A job that exits 2 skips the cache save, so add a separate `actions/cache/save` step with `if: always()` if you want the snapshot kept when alerts fire. Exit code 2 fails the job, which is a handy second notification; append `|| [ $? -eq 2 ]` to the command if you only want the webhook.

## Report files

`crawlmark-cli report` writes data-only report files from a template ([docs/reports.md](reports.md)) for one client (`--client`) or every client (`--all`, discovery first, ignored clients skipped):

```cron
0 6 3 * *  cd /path/to/crawlmark-mcp && /usr/local/bin/node --disable-warning=ExperimentalWarning dist/cli.js report --all --template monthly --format pdf,docx >> /var/log/crawlmark-report.json 2>> /var/log/crawlmark-report.err
```

On the 3rd of each month (Search Console data for the previous month is complete by then) this writes `<home>/reports/<client>/<YYYY-MM>/monthly-<YYYY-MM>.pdf` and `.docx` for each client. Re-running overwrites the same files. `--dry-run` resolves the template, period and file paths and fetches and writes nothing. With `--all` it lists the clients in `clients.yaml` without running discovery, so domains Google added since the last discovery aren't shown.

Output is `{ command: "report", ranAt, dryRun, results, skipped, errors, discovery, exitCode }`. A client whose every section is unavailable or failed is listed in `skipped` and gets no file. Unavailable (for example no Search Console or GA4 property) is a normal state; failed sections (for example an expired Google sign-in) count the client as failed.

| Exit code | Meaning |
|---|---|
| 0 | Every requested report was written and no section failed |
| 1 | Error: bad usage, an invalid template, unknown `--client`, every client failed, a client failed and no report was written, or a file couldn't be written |
| 2 | Written, but a section had `status: "error"`, a requested format failed (for example a PDF without Chrome), or another client failed. Unavailable sources don't count |
