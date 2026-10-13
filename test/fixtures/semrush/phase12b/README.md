# Semrush fixtures for Phase 12 B (keyword ideas and gap)

Hand-built, not recordings; no request was made. Values are invented and every domain is a placeholder.
They live in this subfolder because two header texts are **not confirmed** by the Semrush docs (the parent
folder's test requires every header cell to be documented):

- `Kd`: "Keyword Difficulty" (the reports' current wording) and "Keyword Difficulty Index" (older output) are both accepted; `phrase_fullsearch.csv` uses the second.
- `domain_domains` position columns `P0`/`P1`: assumed to be headed by each domain's name (accepted too: the code itself or a header naming a position).

| File | Report |
|---|---|
| `phrase_related.csv` | `type=phrase_related` with `export_columns=Ph,Nq,Cp,Co,Kd` (one empty `Kd`) |
| `phrase_fullsearch.csv` | `type=phrase_fullsearch`, same columns, CRLF line ends and a quoted field |
| `domain_domains.csv` | `type=domain_domains` with `domains=*\|or\|competitor-a.example\|-\|or\|example.com` and `export_columns=Ph,P0,P1,Nq,Kd` |

The live check (spec 12.B.7) replaces these with scrubbed real responses and settles the header texts.
