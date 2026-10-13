# Scheduled audits and alerts

`crawlmark-cli audit` and `crawlmark-cli check-traffic` are meant for cron or another scheduler. The MCP server stays stateless; these commands are separate runs that print JSON to stdout. The [README](../README.md#scheduled-audits-and-alerts) has the summary.

## What each command does

- **`audit`** runs a fresh `run_audit` for each client, one after another (each audit launches Chrome), saves the snapshot and diffs it against that client's previous audit. A client's first audit is saved as the baseline and raises no alerts. `--all` runs discovery first, so new domains are included. `--urls a,b` overrides the page list for one client. The on-page check inside the audit is the only paid call (DataForSEO, per `DATAFORSEO_BASE_URL`; the sandbox by default).
- **`check-traffic`** compares the last 7 complete Search Console days (ending 3 days ago, because Search Console lags) with the 7 days before, split into branded and non-branded with the same matching as the monthly report. It uses Search Console only, so it is free. Clients without a Search Console property are skipped.
- **Skipping.** A client that is ignored, has no Search Console property (for `check-traffic`) or fails with an error is listed under `skipped` and never fails the run. Only when every client that was tried fails, or an explicit `--client` can't be found, does the run count as an error.
- **`--dry-run`** lists what would run and calls nothing but discovery.

## Alerts

| Alert | When |
|---|---|
| New finding | Any `critical` or `high` finding in this audit that the previous audit did not have |
| Traffic drop | Non-branded clicks down by at least `ALERT_TRAFFIC_DROP_PCT` (default 25) **and** at least `ALERT_MIN_CLICKS_LOST` (default 50) clicks |

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
