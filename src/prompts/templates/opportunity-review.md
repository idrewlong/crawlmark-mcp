Review the SEO opportunities for the client `{{client}}` and write a prioritized content and on-page action list, with an estimate of the click upside for each.

Prefer free tools. Everything below in steps 1 and 2 reads Search Console or local files and is free. Don't call any paid tool unless I ask; step 4 says what to offer.

1. **Context.** Call `list_competitors` with `client: "{{client}}"` for its competitors, `area` and `niche`. Competitors are only context; step 2's tools don't use them.
2. **Run all five opportunity tools** for `client: "{{client}}"`. They share their inputs (`startDate` and `endDate` together, or neither for the last 28 days; `includeBranded`, default false; `limit`, default 25). Use the defaults unless I give a period.
   - `striking_distance`: non-branded queries ranking just below the top (positions 5-20) with an estimate of extra clicks if they reached position 3.
   - `quick_wins`: pages averaging positions 11-20 with their top queries, the pages closest to page one.
   - `low_ctr`: queries in positions 1-5 whose click rate is under 60% of what that position normally gets; candidates for a title and meta description rewrite.
   - `cannibalization`: queries where two or more of the client's own pages split the impressions.
   - `declining_pages`: pages that lost at least 30% of their clicks (and at least 10 clicks) versus the previous equal period.
   Each result reports the window used, a `method` string with the thresholds, the total found and its rows. Report the window and thresholds once. If one tool fails (for example no Search Console property), say which check was unavailable and why, and continue with the others; never fill the gap with guesses.
3. **Write the list.** Merge the results into one prioritized action list, ordered by estimated extra clicks, then ease:
   - Name the page or query, the current position, impressions and clicks, the action (rewrite the title, add content, merge or redirect a cannibalizing page, refresh a declining page), and the estimated click upside from the tool's own estimate. Say these are estimates from an average click-rate curve, not promises.
   - A page can appear in several tools; combine those into one item.
   - Group by action type if that reads better, but keep the priority order clear.
   - Be careful with `cannibalization`: if several of the client's other pages show the same small impression count and zero clicks for a query, that is usually site links under the main result, not real competition between pages. Say that instead of recommending a merge.
   - Where a tool returned no rows, say "none found" for that check; that is a result, not a failure.
   - Percent changes always go with the absolute numbers.
4. **Competitors.** If `list_competitors` returned competitors, they're the comparison set. You can't say how a competitor ranks from the free tools, so don't. Mention that I can ask for these paid checks, with their approximate cost, and run them only if I say yes:
   - `ranked_keywords` with `target` set to a competitor domain: about $0.02 per domain (cached 7 days), shows the keywords it ranks for, to find gaps.
   - `suggest_competitors` (only when the client has no competitors saved or I want more): about $0.03 (cached), it never saves anything.
   Check `spend_summary` (free) first if I say yes, so the cost fits the budget (the client's `monthlyBudgetUsd` is in `list_clients`).
