Write up the SEO and accessibility audit findings for the client `{{client}}`.

Prefer free tools: stored audits (`list_audits`, `get_audit`, `compare_audits`) are free and local, so reuse a recent audit rather than running a new one.

1. **Find the audit to use.** Call `list_audits` with `client: "{{client}}"`. Each audit has an `auditId` and a `ranAt` time. If the newest `ranAt` is less than 7 days before today, use it and tell me its date. If you don't know today's date, say so and run a new audit instead.
2. **Otherwise run one.** If there is no audit, or the newest is 7 days old or more, tell me why you're running a new one, then call `run_audit` with `client: "{{client}}"` and nothing else (its defaults are right). It takes 30-60 seconds per page because it runs Lighthouse and axe in a real browser, and its DataForSEO on-page check is a small paid call per page (cents in total). Don't set `fullCrawl` or `backlinks` (both are paid) unless I ask for them. The result includes the new `auditId`.
3. **Read the findings.** Call `get_audit` with the `auditId` to get the normalised findings and the full result. Each part of the audit reports its own error when a check couldn't run (for example no Search Console property for the index checks). List any such unavailable checks in a short "Not checked" section with the reason. A check that didn't run is not a pass, and a finding you can't see is not evidence of no problem.
4. **Compare.** Call `list_audits` again if you ran a new audit. If the client has only one stored audit, say "There is no earlier audit to compare against, so this is a baseline" and skip `compare_audits`. Otherwise call `compare_audits` with `client: "{{client}}"` (it defaults to the latest versus the one before; pass `baseAuditId` and `targetAuditId` only if I ask for a different pair). Report new findings, resolved findings and persistent ones, plus any Lighthouse score changes. Findings it marks `unverified` were not re-checked in the later audit; list them as unverified, never as resolved.
5. **Write the findings, grouped by severity** (highest first). For each finding give:
   - what it is, in plain language;
   - the affected URLs (all of them if few, otherwise a few examples and the count);
   - why it matters (for search visibility, users, or both);
   - a specific fix (what to change, and where), not "improve performance".
   Mark each as new, persistent, or (where the comparison shows it) resolved.
6. **End with a prioritized fix list.** A numbered list, most valuable and cheapest first, one line each.
7. **Accessibility caveat.** End by noting that automated accessibility checks (axe) find only a subset of problems, so this does not replace a manual accessibility review.

Don't invent findings, URLs or scores that aren't in the audit data.
