/** Editorial: big serif headings, full-page cover, two-column summary. From the approved mockup; fonts come from the font block. */
export const CSS = String.raw`:root { --surface: #ffffff; }
.cover { background: #fff; color: var(--ink); border-radius: 0; border: 0; border-top: 10px solid var(--primary); padding: 70px 0 0; min-height: 0; margin-bottom: 0; }
.cover .kind { color: var(--primary-ink); letter-spacing: .25em; font-size: 12px; }
.cover h1 { font-family: var(--font-heading); font-size: 58px; font-weight: 400; line-height: 1.02; letter-spacing: -.02em; margin-top: 10px; }
.subtitle { font-family: var(--font-heading); font-style: italic; color: var(--muted); font-size: 22px; margin-top: 10px; }
.domain, .badge { color: var(--muted); border-color: var(--rule); }
.cover-meta { border-top: 1px solid var(--ink); margin-top: 60px; padding-top: 12px; }
.cover-meta dt { color: var(--muted); } .cover-meta dd { font-family: var(--font-heading); font-size: 15px; font-weight: 400; }
.contents { background: transparent; border: 0; border-radius: 0; margin: 48px 0 0; padding: 0; break-after: page; }
.contents h2 { font-family: var(--font-heading); font-size: 22px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--ink); border-bottom: 1px solid var(--ink); padding-bottom: 6px; }
.contents ol { columns: 2; column-gap: 32px; padding-left: 22px; margin: 0; } .contents li { margin: 0; padding: 2.5px 0; break-inside: avoid; font-size: 13px; } .contents a { color: var(--ink); text-decoration: none; }
.summary { background: transparent; border: 0; border-radius: 0; padding: 0 0 6px; margin: 4px 0 22px; columns: 2; column-gap: 28px; column-rule: 1px solid var(--rule); font-size: 13.5px; line-height: 1.6; }
.summary h2 { column-span: all; font-family: var(--font-heading); font-size: 26px; font-weight: 400; text-transform: none; letter-spacing: -.01em; color: var(--ink); margin-bottom: 10px; }
.summary table, .summary figure, .summary .table-wrap, .summary h4 { column-span: all; }
.summary p:first-of-type::first-letter { font-family: var(--font-heading); float: left; font-size: 46px; line-height: .9; padding: 4px 6px 0 0; color: var(--primary-ink); }
.kpi, .card, .about { border-radius: 0; box-shadow: none; }
.kpi { border: 0; border-top: 3px solid var(--ink); padding: 10px 2px; background: transparent; }
.kpi-label { font-family: var(--font-body); text-transform: none; letter-spacing: 0; font-size: 12px; font-style: italic; }
.kpi-value { font-family: var(--font-heading); font-weight: 400; font-size: 34px; }
.card { border: 0; padding: 0 0 6px; margin: 0 0 30px; background: transparent; }
.card h2 { font-family: var(--font-heading); font-size: 26px; font-weight: 400; color: var(--ink); letter-spacing: -.01em; border-bottom: 1px solid var(--ink); padding-bottom: 6px; margin-bottom: 12px; }
.card h2::before { display: none; }
h3, .table-title, h4, figcaption { font-family: var(--font-heading); font-size: 15px !important; font-weight: 400 !important; font-style: italic; }
th { font-family: var(--font-body); text-transform: none; letter-spacing: 0; font-style: italic; font-weight: 400; font-size: 11px; border-bottom: 1px solid var(--ink); }
tbody tr:nth-child(even) td { background: transparent; }
.commentary { background: #faf8f3; border-left: 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); border-radius: 0; padding: 12px 16px; font-size: 13px; line-height: 1.6; }
.commentary .label { font-family: var(--font-heading); text-transform: none; letter-spacing: 0; font-size: 14px; font-style: italic; font-weight: 400; color: var(--muted); }
.tile { background: transparent; border-top: 1px solid var(--rule); border-radius: 0; }
.chip.good, .chip.bad, .chip.neutral { background: transparent; padding: 0; }
.about { background: transparent; border: 0; border-top: 1px solid var(--ink); }
@media print {
  .cover { padding-top: 120px; } .cover h1 { font-size: 54px; } .cover-meta { margin-top: 90px; }
  .contents { margin-top: 70px; }
  .card { padding: 0 0 4px; margin-bottom: 22px; } .card h2 { font-size: 22px; }
  .summary { font-size: 11.5px; }
  .kpi { padding: 8px 2px; } .kpi-value { font-size: 28px; }
}
@media (max-width: 640px) { .contents ol { columns: 1; } .summary { columns: 1; } .cover { padding-top: 36px; } .cover h1 { font-size: 38px; } .cover-meta { margin-top: 30px; } }
`;

export const ONEPAGE_CSS = String.raw`.cover { padding-top: 18px; } .cover h1 { font-size: 34px; } .subtitle { font-size: 16px; } .cover-meta { margin-top: 14px; } .contents { break-after: auto; margin-top: 14px; } .summary { columns: 1; } .card h2 { font-size: 18px; }
@media print { .cover { padding-top: 18px; } .cover h1 { font-size: 34px; } .subtitle { font-size: 16px; } .cover-meta { margin-top: 14px; } .contents { break-after: auto; margin-top: 14px; } .summary { columns: 1; } .card h2 { font-size: 18px; } }
`;
