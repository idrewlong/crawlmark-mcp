Help me find and save competitors for the client `{{client}}`.

Work through these steps in order, and wait for my answer where a step says to ask.

1. **Profile.** Call `list_competitors` for `{{client}}` to see its current competitors, `area` and `niche`.
   - `area` is a DataForSEO location name in the form `City,Region,Country` (for example `Austin,Texas,United States`). It focuses the search on local results. Leave it unset for a business that sells nationally or online.
   - `niche` is a few words on what the client does (for example `emergency plumber`). It's used as the first search keyword.
   - Set or confirm `area` and `niche` before step 2. Without them, seeds fall back to Search Console queries (often dominated by brand-like terms) and the search is national, so the candidates are much weaker.
   - If either is unset, don't skip ahead: propose values inferred from the client's homepage title and description (read the homepage with a web fetch if you have one, or simply ask me). If the business is local, propose an `area`; if it sells nationally or online, say so and leave it unset on purpose.
   - Tell me what's set and what you propose, and ask me to confirm. When I confirm changes, save them with `set_client_profile`.
2. **Seeds.** The client's own ranked keywords are mostly branded, so propose 3-5 non-branded service keywords (what a customer would search, from the niche and the homepage; never the brand name). Confirm them with me, then pass them as `seeds`.
3. **Suggest.** Call `suggest_competitors` for `{{client}}` with those `seeds`. It's a paid DataForSEO call (results are cached), and it never saves anything.
4. **Present.** Show the candidates in a short table: domain, score, and the evidence in plain words (for example "ranks in the top 3 for 4 of 5 local searches" or "shares 120 keywords, average position 8"), with the sample URL. Mention the seeds that were searched, the market used, anything excluded and why, any notes, and the cost. If the response says a source failed or no seeds were searched, say so plainly instead of guessing.
5. **Ask.** Ask me which candidates to add. Don't add any until I answer. I may also name competitors that weren't suggested.
6. **Save.** Call `add_competitors` for `{{client}}` with the domains I chose and `source: "suggested"` (use `source: "manual"` for ones I named myself), adding a short `note` with the evidence if useful. Report what was added and anything skipped, with the reason.

Prefer free tools where they answer the question. If any data is unavailable (a tool failed, or the client has no Search Console property), say so plainly instead of guessing. Keep the conversation brief.
