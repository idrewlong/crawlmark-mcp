# How should crawlmark's generated PowerPoint decks look? (design brief for the next deck pass)
Date: 2026-11-01 23:05 local (2026-11-02 UTC) · Author: my-skills:researcher · Requested by: orchestrator · Status: final

## Answer (TL;DR)
Our decks have the right content but look like a PDF page cut into slides. Content is small and sits in the top third, all six themes look the same on slides, and panels have no breathing room. Professional SEO and report decks do the opposite. Content blocks fill the content area edge to edge. Each slide has one dominant element (a hero number, a big chart or a full-width table) at 2 to 3 times our current type size. A one-line takeaway or banner states the point. Each theme commits to one surface treatment: cards, hairlines, serif editorial, heavy colour blocks, a consulting label column, or pills. Confidence: **high** on the gaps and patterns, which are observed directly in the sources below. **Medium** on the exact sizes, which come from our 13.333 × 7.5 in grid and are scaled from the templates where noted.

Scope note: the current deck samples were rendered before the builder's in-flight changes (optical centring, table type scaling, the chart caption row in `chart-style.ts`). This brief assumes those changes land and goes further.

## Findings

### What we looked at
- **Our decks:** `/Users/idrew/Desktop/crawlmark-0.4.0-samples/*.pptx`, plus the Keynote PDFs of Bold, Consulting and Friendly (17 slides each). **Approved mockups:** `/Users/idrew/Desktop/crawlmark-theme-mockups/{1-cards,2-minimal,3-editorial,4-bold-v2,5-consulting,6-friendly-v2}.pdf`.
- **Local template "Minimal Geometric SEO Strategy Presentation" (SlidesCarnival/Canva credits):** I exported it to PDF with Keynote, 21 pages viewed, and unzipped a copy. The slide is 20 × 11.25 in (`ppt/presentation.xml` `sldSz cx=18288000`), so the sizes below are scaled by 0.667 to our 13.333 in width. Theme palette: 191919 / F7F7FF / 2274A5 / C287E8 / 85FF9E. Its resource slide names Archivo Black for titles, Hind SemiBold for headers and Hind for body. Run sizes on its slides: body 18 pt (12 pt at our scale), headings 32 pt (21 pt), section titles 90–95 pt (60–63 pt).
- **SlideModel "Website Performance Report" (item 94231-01):** 12-slide public preview images, linked from slidemodel.com search page 2 for "seo".
- **Slidesgo:** "SEO Monthly Report" (24 thumbnails) and "KPI Report for Business" (24 thumbnails), found by searching "seo report".
- **SlidesCarnival "competitor-analysis" tag:** "Modern Website Competitor Analysis" and "Geometric Product Competitive Analysis" (15 previews each).
- **Guidance:** consulting slide structure (action titles, one message per slide) and KPI-card practice (big number plus comparison plus trend, uniform sizing).

I only viewed public preview images. Nothing paid was downloaded, I didn't log in, and no artwork, fonts or files were copied into the repo.

### Our current decks: what's wrong (observed in the Bold, Consulting and Friendly PDFs)
1. **Empty bottoms.** Table slides (Page movers, Top landing pages, Tracked keywords, Opportunities, Tag Manager findings) use about 25–35% of the content area. Rows are about 0.22 in tall at about 10 pt, and the bottom 60% of the slide is empty. "Changes since the last audit" has one table row plus four tiny tiles.
2. **Key numbers is weak.** Four values at 32–44 pt sit in the top 30% of the slide, with a caption stranded near the footer.
3. **Summary.** Three 18 pt bullets sit at the top of a full-height tinted panel, with a vertical accent rule right against the bullet glyphs.
4. **Agenda.** Eleven items at 18 pt crowd into the top 40%.
5. **Chart slides.** The chart's own title and legend overlap ("Clicks per day" drawn over "September 2026 / August 2026"). The side bullet panel runs full height but its text fills only the top quarter. The 2×2 KPI tiles beside the GA4 chart are cramped.
6. **The six themes are nearly identical on slides.** Bold, Consulting and Friendly differ only in the title treatment and the cover fill. Body slides are the same white page with the same blue line chart. In the mockups the themes are far more distinct.
7. **"More detail in the full report." is repeated on most slides**, adding noise in the bottom-left.
8. **Cover.** The text block is in the upper-left quadrant and the right half is empty. Agency name and logo float.

### 15 patterns strong SEO and report decks use that ours don't
| # | Pattern (observable) | Where seen |
|---|---|---|
| P1 | **The content area is fully used.** Panels, cards and tables stretch from under the title to about 0.4 in above the slide bottom. No slide ends in its top third. | SlideModel Website Performance (all 12 slides); Geometric SEO "Paid keyword budget" (the table fills the slide width and height) |
| P2 | **A hero number beside a chart.** A tall card holds one big total (for example "446.7K" plus a delta chip and "vs last period") to the left of the trend chart. | SlideModel Website Performance, "Executive Summary" |
| P3 | **KPI card anatomy.** Small label at top-left. Value 3–4× the label size. A delta chip right of the value or under it. A "vs X last period" line underneath. All cards share one size and one value size. | SlideModel "Executive Summary" and "Scorecard" (scorecard values about 72 pt at our scale); our own Cards, Bold and Friendly mockups; Maersk DS big-number guidance |
| P4 | **Status pills on metrics** (GOOD / AVERAGE / POOR, or High / Med / Low priority), tinted by tone. | SlideModel "Scorecard", "Performance Bottlenecks", "Optimization Matrix" |
| P5 | **A full-width verdict banner** at the bottom of a dashboard slide: one sentence that states the conclusion, on an accent fill. | SlideModel "Core Web Vitals Dashboard", "User Experience & Page Journey" |
| P6 | **Area-filled current-period line plus a dashed grey previous period.** The fill is a light tint or gradient under the current line. | SlideModel "Performance Trends", "Business Impact", "Executive Summary"; **our own approved mockups** (all six show a tinted area under the current line, a dashed previous line, and sparse date ticks 1 / 11 / 20 / 30 Sep) |
| P7 | **The chart sits in its own panel** with its title inside the panel top-left. The side column carries 1–2 big stat call-outs (for example "+32%" plus a bold label plus one line), not a wall of bullets. | SlideModel "Performance Trends" |
| P8 | **Section and number structure is visible.** Large accent numerals (01, 02) on section or agenda items, section dividers with a 60 pt+ numeral. | Geometric SEO (dividers "01 Introduction", "02 Strategies"); Slidesgo SEO Monthly Report ("01 SEO health", "02 Backlink profile"); Slidesgo KPI Report ("01 KPI Report") |
| P9 | **The agenda is a grid of numbered blocks**, not a long list. Items are distributed over the whole content area, with 2×2, 2×3 or 3-across boxes, often with a one-line description. | Geometric SEO TOC (2×3 colour blocks plus a column); Slidesgo SEO Monthly Report TOC (2×2, numerals in filled squares); SlidesCarnival Geometric and Modern Website (boxed 01/02/03 with titles) |
| P10 | **A big-number slide.** One statistic centred at about 60–80 pt with a one-line caption, or three stacked big numbers. | Slidesgo KPI Report for Business ("98,300,000", plus the stacked "9h 55m 23s / 333,000 / 386,000 km") |
| P11 | **Readable full-width tables.** Rows about 0.45–0.55 in at our scale. The first column is a bold or emphasised label column, separated by a vertical hairline. Tables sit in a card spanning the full content width. A bold header row. | SlideModel "User Experience & Page Journey"; Geometric SEO "Paid keyword budget" (rows distributed to fill the height) |
| P12 | **Ranked bars with value labels at the bar end**, bold category labels on the left, no value axis. | Slidesgo SEO Monthly Report ("Page Backlink Factors", "On page factors") |
| P13 | **Donut or ring for a single share** (for example 43%) with the % in the centre. | SlidesCarnival "Market Research" slide (both templates); Slidesgo KPI Report "percentages" |
| P14 | **Strong title typography with one accent.** Titles are large (about 28–40 pt at our scale), short and left-aligned. Some put one word in the accent colour, or set the title in a heavy display face. | SlidesCarnival Modern Website ("WEBSITE COMPETITOR **ANALYSIS**"); Geometric SEO (all-caps 60 pt dividers); Slidesgo SEO Monthly (heavy display titles) |
| P15 | **Action titles and one message per slide.** The title or a subtitle states the conclusion, and everything on the slide supports it. A small source line sits at the bottom. | Consulting guidance (deckary.com consulting slide standards; SlideModel "One topic per slide"; ampler.io key-takeaway slide) |
| P16 | **Colour blocking as frame.** Solid brand-colour rectangles bleed off the slide edges (top-right, left strip, bottom band) to give each layout a recognisable structure without imagery. | Geometric SEO (every slide); Slidesgo SEO Monthly (vertical accent bar on the right edge of every slide) |

## Layout recipes per slide type (13.333 × 7.5 in)

**Shared grid.** This keeps the existing `SLIDE` constants where possible (`src/reports/render/pptx/master.ts:15`).

| Zone | Region |
|---|---|
| Margins | L/R 0.5 in (current). Recommend 0.6 in for themes with card surfaces, so the cards don't touch the visual edge (*inferred*). |
| Title | y 0.35–1.15 in. **28–32 pt** (Editorial 34 pt serif, Bold 30 pt Arial Black). Never wraps to more than 2 lines; reduce to 24 pt before wrapping. |
| Takeaway line (new, optional) | y 1.12–1.50 in, 16 pt muted, one sentence. Only text that already exists in the report (see change #6). |
| Content | y 1.65 (1.35 if there's no takeaway) to 6.70 in, so about 5.05 in tall. **Main / side split:** main x 0.5–8.6 (w 8.1), side x 8.85–12.83 (w 3.98). |
| Footer | y 7.0 in, 9 pt faint. Page number right. Source line left (for example "Source: Google Search Console, 1–30 Sep 2026"). |
| Gaps | Between cards 0.25 in. Inner padding of any panel 0.3 in all sides (0.25 minimum). Never let text touch a panel edge or an accent rule. |

**Space-filling rules for all body slides.** These are the core fix.
1. **Measure, then scale up.** Lay the content out at the base size. If it fills less than 70% of the content height, step type and row height up through the ladder (body 14 → 16 → 18 → 20 pt; table rows 0.42 → 0.5 → 0.6 → 0.7 in). Stop when it fills 70–90% or hits the maximum.
2. **If it still fills less than 60% after scaling, add a support element** in this priority order. All of them use data the slide already has: (a) a hero number for the slide's primary metric, (b) a verdict or takeaway banner at the bottom, (c) in-cell bars in the table's primary numeric column. Centre the block optically (42/58 split, as the builder already does).
3. **If content overflows,** split it onto a "continued" slide at a row or bullet boundary. Never shrink body text below 14 pt (tables) or 16 pt (bullets).

### Title (cover)
- **Text block.** Left column x 0.9 to about 8.4 in (w 7.5), vertically centred as a group around y 3.6 in:
  - kicker, 14 pt caps, tracked 1.5
  - title, **54–60 pt**, max 2 lines, fit by measurement
  - subtitle, 22 pt
  - domain, 14 pt
- **Meta row.** Pinned at y 5.6–6.3 in as 3–4 fields: label 10 pt caps muted over a 16 pt bold value, each field 2.4 in wide. Friendly: each field in a pill chip, as in the mockup.
- **Right region.** x 8.8–12.8 in. Never leave it empty. Use the theme element (see the themes section): a colour block, a large faint numeral, or the logo at max 2.4 × 1.0 in. Agency name sits under the logo, or at the bottom-left on the meta row baseline.
- **Long content.** The title shrinks to 44 pt before wrapping to 3 lines. Cut the subtitle at 80 characters.

### Agenda
- **≤ 6 items: grid of blocks.**
  - 3 columns × 2 rows. Each block is (12.33 − 2 × 0.25) / 3 = **3.94 × 2.4 in**.
  - Numeral 40 pt accent ("01"). Item 20 pt bold below it, then an optional one-line description (14 pt muted). Use the section's takeaway or its first commentary sentence if available.
  - Card themes fill the blocks. Rule themes use a 0.75 pt top rule per block.
- **7–12 items: two columns, rows evenly distributed** over the full 5.05 in. Row height is 5.05 / ceil(n/2), so 0.84 in for 6 rows. Numeral 28 pt accent, item 20 pt, a hairline between rows.
- **Long content.** More than 12 items: 3 columns at 18 pt. Never stack at the top with fixed 14 pt spacing (the current behaviour).

### Key numbers (4 KPIs with change chips)
- **Band of 4 equal cards.** y 1.75–5.05 (h 3.3 in), w (12.33 − 3 × 0.25) / 4 = **2.9 in** each.
- **Inside each card (padding 0.3):**
  - label 14 pt caps tracked (Editorial: 15 pt italic, no caps)
  - **value 66–72 pt** (scale down per value so the widest fits; keep all four the same size, as Maersk DS advises)
  - delta chip 16 pt bold ("▲ 17.6%"), pill radius 50%, tone tint
  - comparison line 13 pt muted ("vs 952 in August")
  - lower-is-better note 12 pt ("lower is better") where relevant
- **Below the band.** y 5.35–6.45: a full-width **verdict banner** (P5), 18 pt, tinted or theme fill, 0.3 in padding. Content is the report's first summary sentence if there is one. Otherwise the comparison caption ("Change vs August 2026, the previous period") moves here as 14 pt muted text, centred.
- **Fewer KPIs.** 1 KPI: a centred big-number slide (value 96 pt, label 18 pt, chip 20 pt) (P10). 2: two cards of 5.9 in. 3: three cards of 3.94 in. 5–8: two rows of 4, h 2.4 each, value 48 pt.

### Summary (3–5 bullets)
- **No full-height panel** with text in the top quarter, and no accent rule touching the bullets.
- **≤ 3 bullets: three insight cards across.** Each is 3.94 × 3.6 in, centred vertically. Inside: index numeral 36 pt accent ("1"), then the bullet text at **22–24 pt**, line spacing 1.15.
- **4–5 bullets: stacked insight rows** distributed over the content height. Row h = 5.05 / n (about 1.0 in for 5). Each row has a numeral (28 pt accent) in a 0.8 in column, text at 22 pt, and a hairline between rows.
- **Editorial.** The first bullet becomes a 30 pt serif lead sentence (a drop cap is optional, as in the Editorial mockup). The rest are 18 pt bullets below it.
- **Long content.** A bullet longer than 2 lines at 22 pt drops to 20 pt. If it still doesn't fit, use a two-column list. The source caption ("Written commentary; all figures come from the data") goes to the footer source line.

### Chart section (one native chart + top table rows + up to 3 bullets)
- **Chart panel.** x 0.5–8.6, y 1.65–6.70 (8.1 × 5.05 in). Card themes draw a white card here; other themes draw nothing.
- **Chart caption row inside the panel**, 0.3 in from the panel's top-left: the chart title at 16 pt bold left, the legend at 12 pt right on the same row (h 0.4). The plot area takes the rest. The builder's `chartCaption` already does the row; only the size and padding change.
- **Side column.** x 8.85–12.83, top-aligned with the chart panel, **same height**, so the top and bottom edges align.
  - **Top: a hero stat** if the section has KPIs. Value 44 pt, delta chip 14 pt, label 12 pt caps (P2/P7).
  - **Then a "What changed" heading** (11 pt caps, accent) and up to 3 bullets at **16–18 pt**, with 10 pt space after each.
  - **No vertical rule against the bullets.** If the theme has a left rule (Bold, Cards), the text inset from the rule is **≥ 0.3 in**.
  - Leftover height stays inside the panel as padding, but the panel is only drawn as tall as the chart when a hero stat fills the top. Otherwise fit the panel to the bullets and centre it against the chart's plot area, not the slide.
- **Chart plus table, no bullets.**
  - If the table has ≥ 4 columns, stack: chart y 1.65–4.30 (2.65 in), table y 4.55–6.70 (header plus up to 4 rows at 0.42 in).
  - If the table has ≤ 3 columns, go side by side: chart 8.1 in wide, table in the side column at 14 pt.
- **Long content.** Table rows beyond what fits move to the "continued" slide. Bullets cap at 3, and longer commentary goes to the notes.

### Table section (table only, or table + side bullets/tiles)
- **Full width** x 0.5–12.83 when there's no side content. Header row 0.45 in, 12 pt caps (theme). Body rows are **0.5–0.7 in at 16–18 pt** for ≤ 5 rows, and 0.42 in at 14 pt for 6–8 rows.
- **First column.** Text left, semibold for the label column. Numeric columns right-aligned, header labels included. Change columns are coloured with ▲/▼ (green #1a7f37-ish or red, theme tone).
- **Short tables (≤ 4 rows) after scaling still under 60% fill:** add **in-cell bars** to the primary numeric column (Clicks or Sessions). These are thin rectangles at 35% tint, 0.12 in high, under or after the number, with length proportional to the value (P1/P11; *inferred adaptation* of SlideModel's progress bars). Or add a verdict banner from the first commentary sentence.
- **With a side column.** The table is 8.1 in wide and the side column follows the chart-section rules.
- **Long content.** Max 8 rows on the first slide. The rest go to "continued".

### KPI tiles + chart
- **Tiles go in a top row, not a 2×2 grid squeezed into the side column.** Tile row y 1.65–3.05 (h 1.4 in), 4 tiles × 2.9 in: value 36 pt, label 12 pt caps, chip 13 pt, comparison 11 pt.
- **Chart** below at y 3.30–6.70 (12.33 × 3.4 in, full width, which suits a 30-day series).
- **Commentary.** If there are bullets as well, the chart drops to 8.1 in wide and the bullets go right of it (side-column rules).

### "(continued)" table slide
- **Title.** The section title, then a muted tag "continued" at 14 pt (pill in Friendly, italic in Editorial), instead of "(continued)" in the title run. Same numeral as the first slide in Consulting.
- **Table.** Same column widths and header as the first slide of the section, so the two read as one table. Up to 10 rows at 14 pt (row 0.45 in). Apply the same fill and scale rules.
- **Truncation note** ("Top 8 of 23 rows; the full table is in the report") at 11 pt muted directly under the table, not floating above the footer.

### Text block
- **≤ 4 bullets** at 24 pt, as insight rows (summary rules).
- **5–8 bullets** at 20 pt in two columns of 5.9 in.
- **Never smaller than 18 pt.** Split into a second slide titled "…, continued" instead.
- **A single paragraph** becomes a 28 pt lead sentence, with the rest at 18 pt.

### Closing
- **Centred group**, vertically centred:
  - "Thank you" at 54–60 pt
  - agency name, 16 pt caps tracked
  - contact lines, 16 pt, in a row with 0.5 in gaps, not stacked at 12 pt
  - logo above the title, max 2.4 × 1.0 in
- **Theme frame.** Same as the cover (fill, strip or block) so the deck is bookended.
- *Optional, inferred:* if the report has an Opportunities section, a "Next steps" variant puts the top 3 opportunities as three cards (title 18 pt, estimated extra clicks as a 36 pt number) above the contact line. It uses only existing data.

## Theme expression on slides (consistent with the approved mockups)

| Theme | Surface and background | Title | KPI | Charts | Signature element |
|---|---|---|---|---|---|
| **Cards** (mockup 1) | Body bg #F4F6F9. **Every content block sits in a white rounded card** (radius about 0.12 in, 1 pt #E4E7EB border, no shadow). Commentary goes in a light primary-tint card. | 28 pt bold primaryInk, short 0.06 × 0.4 in primary bar at left | White card, value 66 pt bold ink, **green or red tinted pill chip** | Area fill (primary at about 15%) under the current line, dashed grey previous line | Cards that align to the grid. Cover is a primary full-bleed panel with an accent bottom strip (current). |
| **Minimal** (mockup 2) | White, **no panels or fills at all**. Structure comes from 0.75 pt hairlines and whitespace. | 30 pt regular ink, full-width hairline under it | No card. Hairline separators between KPIs. Value 66–72 pt **regular weight**. Delta as coloured text, no chip. Labels 11 pt caps tracked. | Single ink or primary line, light fill (about 8%) or none, minimal gridlines | Large light numerals and generous margins. Fill space by scaling type up, not by adding boxes. |
| **Editorial** (mockup 3) | White, warm callout tint #FAF8F3, Georgia throughout | 34 pt serif regular, hairline under it. Thick primary strip at the top of the cover only. | 3 pt ink top rule, value 60 pt serif, **italic labels** (no caps) | Thin lines (1.75 pt), italic axis captions and legend | Serif **lead sentence or drop cap** on Summary and text slides. Italic table headers. Pull-quote style takeaway. |
| **Bold** (mockup 4-bold-v2) | White body. **Dark navy full-bleed cover and closing.** Heavy rules. | **30 pt Arial Black** dark, short 0.6 in primary bar over a full-width grey rule | 4 pt primary top rule, **value 72 pt Arial Black**, bold caps labels, tinted chip | Thicker current line (3 pt), stronger fill (about 20%), bold axis labels | **Colour blocking** (P16): a dark or primary block bleeding off one edge on the agenda and key-number slides (for example a 0.35 in primary band at the right edge). Callout with a 4 pt left rule and ≥ 0.3 in text inset. |
| **Consulting** (mockup 5) | White, hairlines, grey #F6F7F9 callout | 28 pt regular ink, **section numeral "01" in accent**, hairline **above** the title. **Takeaway line under the title on every section slide** (P15). | Values 60 pt regular **in primaryInk**, hairline separators, caps labels, coloured text deltas | Muted gridlines, line and fill in primary, source line in the footer | **Label column**: the commentary block gets a 2.0 in left column with a small caps label ("SUMMARY", "WHAT CHANGED") and the text to its right, as in the mockup's "SUMMARY" row. A left vertical strip on the cover. |
| **Friendly** (mockup 6-friendly-v2) | Wash bg. **Rounded white cards with a larger radius** (about 0.2 in). Trebuchet MS. | Title in a **tinted pill** (current). Section tag "● Search performance" style. | Rounded white card, value 60 pt bold, **pill chips** | Rounded feel: smooth lines (`c:smooth val="1"`), soft fill (about 15%), legend as pill-like markers | **Pill chips everywhere**: cover meta fields (as in the mockup), "continued" tag, status pills (P4). |

## Chart and table styling rules (slides)
- **Legend.** One caption row above the plot: title left (16 pt bold), legend right (12 pt). Never inside the plot or overlapping the title. Hide the legend for a single series. Already moving this way in `chart-style.ts` and `slides.ts:chartCaption`.
- **Axes.**
  - Value-axis labels 11–12 pt muted. Abbreviate ≥ 10,000 with the `#,##0,"k"` / `#,##0,,"M"` format codes.
  - At most 5 intervals, "nice" ticks (the builder's `niceUnit`).
  - Category labels about 6–8 per axis (1, 6, 11 … Sep), which `tickLblSkip` already gives.
  - No axis titles unless the unit is ambiguous (positions, ms).
- **Gridlines.** Horizontal only, 0.5 pt #E5E7EB. No vertical gridlines, plot border or value-axis line. Keep only the category baseline.
- **Highlight the current period.**
  - Current series: 2.5–3 pt primary line with an area fill tint (P6).
  - Previous series: 1.5 pt grey #9AA5B1 dashed, no fill.
  - Add **one end-point marker and data label** on the last current value (a `c:dLbl` with `idx` = last point) so the slide shows the latest number.
- **Number formatting.**
  - Thousands separators everywhere.
  - Percentages 1 decimal ("5.6%"). CTR changes in "pts".
  - Positions 1 decimal, with "better/worse" wording instead of signed numbers (already the case).
  - Durations: ms under 1,000, else "2.3 s".
  - Deltas always signed with ▲/▼.
- **Bars.**
  - Share (branded vs non-branded): bars at least 0.45 in thick, % labels **inside** the bars (white, 12 pt bold), as in all six mockups.
  - Ranked lists: horizontal bars with value labels at the bar end and no value axis (P12).
- **Tables.**
  - Header 12 pt (caps per theme), body 14–18 pt via the scale ladder, rows 0.42–0.7 in, cell padding 0.08/0.11 in.
  - Numbers right-aligned with their headers. Text left. Never centre numbers.
  - Zebra only for Cards, Bold and Friendly (very light). Hairline row rules for Minimal, Editorial and Consulting.
  - The first column can be semibold. URLs show the path only, truncated in the middle ("/blog/…/water-heaters").
  - Max 6 columns and 8 rows (10 on continued slides).
  - Change columns coloured by tone. Header rule 1 pt in the theme colour.

## Do not
- Don't leave more than about 40% of the content area empty on a body slide. Scale up or add a support element instead (rules above).
- Don't draw a full-height panel around content that fills a quarter of it. Fit the panel or fill it.
- Don't put text against an accent rule or panel edge. Inner padding is at least 0.25 in.
- Don't keep a native chart title or legend inside the chart part. No overlapping text.
- Don't shrink body text below 14 pt (tables) or 16 pt (bullets) to fit. Split into a continued slide.
- Don't use stock photos, illustrations, icon packs, template fonts or template artwork. Theme identity comes from type, colour, rules and shapes we draw.
- Don't invent takeaways. Banners and takeaway lines only reuse report text (summary or commentary sentences, chart summaries).
- Don't use 3D charts, pie charts with more than 3 slices, rainbow series colours, or more than 2 accent colours per slide.
- Don't repeat "More detail in the full report." on every slide. Show a truncation note only where something was truncated.

## Prioritized changes (implementable in our OOXML writer, no new dependencies)
1. **Fill-the-area layout engine (all body slides).** In `slides.ts`, add a `fit(contentH)` step: measure the laid-out height with the existing `bulletsHeight`, `tableLayout` and `tileHeight`, then step type and row height up the ladder until fill reaches 70–90%. Generalise `tableLayout`'s current 12–16 pt ramp to 14–20 pt, with rows up to 0.7 in. The agenda distributes rows over the content height instead of using `before: 14`. *Biggest single visual win.*
2. **Key numbers hero band (kpis).** Tiles stretch to h 3.3 in. The value ramp goes to 66–72 pt: raise `TILE_TYPE.hero.valueMax` and the theme `valueSize` values in `deck-themes.ts`. Chip 16 pt. The comparison caption moves into a verdict banner at y 5.35. The banner is a filled rounded or plain rect plus a text box.
3. **Side column rework (chart and table sections).** The side column is equal in height and top-aligned with the chart panel. Add a hero stat on top when KPIs exist. Bullets 16–18 pt. Text inset from any left rule of at least 0.3 in: change `panelPad` / `bulletPanel` lIns. Move KPI tiles from a 2×2 side grid to a top tile row with a full-width chart below (the KPI + chart recipe).
4. **Chart polish (`chart-style.ts`, deck-only XML edits).**
   - Horizontal gridlines only, at 0.5 pt #E5E7EB.
   - Current line 2.5–3 pt, previous line dashed grey.
   - k/M number formats on the value axis.
   - A last-point `c:dLbl`.
   - In-bar % labels for share bars (`c:dLbls` with `c:showVal`, position `ctr`, white text).
   - Area fill: add a duplicate current series as `c:areaChart` (primary with `a:alpha val="15000"`) in the same `c:plotArea`, sharing axes. **Verify in Keynote, PowerPoint and LibreOffice before shipping.** Keynote's handling of combo area+line is unverified (*inferred risk*). Fall back to no fill per app if it breaks.
5. **Theme surfaces (all slides).** Add a `surface` block to `DeckTheme`: `{ kind: "card" | "rule" | "none", radius, border, cardFill, bgBlock? }`. Draw it in `slides.ts` behind the chart, table and tile regions:
   - Cards: white rounded cards on #F4F6F9.
   - Friendly: larger radius and pills.
   - Bold: an edge colour block plus Arial Black 72 pt values.
   - Consulting: the label column.
   - Editorial: the serif lead sentence.
   - Minimal: hairlines only.

   This makes the six decks look like their mockups instead of one deck in six colours.
6. **Takeaway line / action subtitle (section, kpis).** Add an optional `takeaway?: string` to the section and kpis slide types in `deck.ts`. Take it deterministically from `sec.commentary` (first sentence, which `condense` already computes), or from `chart.summary` (for example "Search clicks are up for the third month in a row"). Render it at 16 pt muted, y 1.12–1.50, and shift content down 0.3 in. Remove the sentence from the bullets so it isn't duplicated. Mandatory in Consulting, optional elsewhere.
7. **Agenda grid.** ≤ 6 items: a 3×2 block grid with 40 pt numerals. 7–12: two evenly distributed columns with 28 pt numerals and hairlines. Optional one-line descriptions from section takeaways (#6).
8. **Summary as insight cards or rows.** ≤ 3 bullets: three cards across, 22–24 pt. 4–5: distributed rows with numerals. Remove the full-height tinted panel and the left rule. Editorial gets a serif lead.
9. **Readable tables plus in-cell bars (table and continued slides).** Change columns get ▲/▼ tone colour, and the first column is emphasised. Continued slides get a "continued" tag and the same column widths as the first slide. When fill is still under 60%, draw in-cell bars: separate `rect` shapes positioned from the known `rowH` and column x. They are reliable because row heights are fixed and computed. Watch for apps that grow rows on wrap, and only add bars when no cell wraps.
10. **Cover and closing composition.** Vertically centre the cover text group. Pin the meta row at y 5.6. Fill the right region with the theme element or logo. Make the closing a centred group mirroring the cover frame. Drop the per-slide "More detail in the full report." except where something was truncated.

What would change these priorities: if Keynote can't render the combo area chart, #4 drops to the line and label tweaks only. If the user wants decks to carry more narrative, #6 rises to #2.

## Recommendation
Do #1, #2, #3 and #5 as one design pass (layout engine plus theme surfaces). They fix the "empty space, cramped panels, generic layouts" complaint on every slide. Do #4 (chart polish) in parallel in `chart-style.ts`, gated on a three-app render check. Then #6–#10. Validate each theme against its mockup by exporting all six sample decks to PDF with Keynote and comparing them side by side, as was done for this brief.

## Sources
- Local template: "Minimal Geometric SEO Strategy Presentation.pptx" (SlidesCarnival / Canva credits slide), exported via Keynote and inspected (`ppt/theme/theme1.xml`, `ppt/presentation.xml`, slide XML run sizes). Accessed 2026-11-01.
- [SlideModel search "seo", page 2](https://slidemodel.com/page/2/?s=seo). Accessed 2026-11-01.
- [SlideModel: Website Performance PowerPoint Template (94231-01)](https://slidemodel.com/templates/website-performance-powerpoint-template/). Public preview images of slides 2–11. Accessed 2026-11-01.
- [Slidesgo: SEO Monthly Report](https://slidesgo.com/theme/seo-monthly-report). Thumbnail gallery. Accessed 2026-11-01.
- [Slidesgo: KPI Report for Business](https://slidesgo.com/theme/kpi-report-for-business). Thumbnail gallery. Accessed 2026-11-01.
- [Slidesgo search "seo report"](https://slidesgo.com/search?q=seo+report). Accessed 2026-11-01.
- [SlidesCarnival: competitor-analysis tag](https://www.slidescarnival.com/tag/competitor-analysis); [Modern Website Competitor Analysis](https://www.slidescarnival.com/template/website-competitor-analysis-slides/211478); Geometric Product Competitive Analysis (preview images on the same tag page). Accessed 2026-11-01.
- [Deckary: consulting slide standards](https://deckary.com/blog/consulting-slide-standards); [Deckary: present data effectively in PowerPoint](https://deckary.com/blog/present-data-effectively-powerpoint). Action titles, one message per slide. Accessed 2026-11-01 (search snippets; vendor blog).
- [SlideModel: One topic per slide](https://slidemodel.com/one-topic-per-slide/). Accessed 2026-11-01 (search snippet).
- [Ampler: key takeaway slide like a McKinsey consultant](https://ampler.io/articles/how-to-create-a-key-takeaway-slide-like-a-mckinsey-consultant-with-examples/). Accessed 2026-11-01 (search snippet).
- [Tabular Editor: KPI card best practices](https://tabulareditor.com/blog/kpi-card-best-practices-dashboard-design); [Maersk Design System: big number chart](https://designsystem.maersk.com/guidelines/data-visualisation/chart-types/big-number-chart/). Comparison context, uniform big-number size. Accessed 2026-11-01 (search snippets).
- Internal: `/Users/idrew/Desktop/crawlmark-theme-mockups/*.pdf` (approved look); `/Users/idrew/Desktop/crawlmark-0.4.0-samples/*.pptx` and the Keynote PDFs (current state); `src/reports/render/pptx/{slides,master,chart-style}.ts`, `src/reports/render/themes/deck-themes.ts`, `src/reports/render/deck.ts` (working tree on release/0.4.0).
