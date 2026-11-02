/** Friendly (v2): soft rounded shapes, cool light tints of the primary colour, pill headings. The tints and chip colours come from the palette (vars). */
export const CSS = String.raw`.cover { border-radius: 22px; border: 0; padding: 26px 30px 22px; background: var(--primary); }
.cover h1 { font-size: 34px; font-weight: 700; letter-spacing: -.01em; }
.cover-meta { border-top: 0; gap: 8px 10px; padding-top: 14px; }
.cover-meta > div { background: var(--chip-bg); border-radius: 14px; padding: 7px 14px; }
.cover-meta dt { color: var(--on-chip-soft); }
.contents, .summary, .card, .about { border: 0; border-radius: 20px; background: #fff; box-shadow: 0 1px 2px rgba(20,40,70,.06), 0 4px 14px rgba(20,40,70,.05); }
.contents { padding: 16px 22px; }
.contents h2, .summary h2 { color: var(--tint-ink); text-transform: none; letter-spacing: 0; font-size: 16px; font-weight: 700; }
.contents ol { columns: 2; column-gap: 28px; margin: 0; } .contents li { margin: 0; padding: 2.5px 0; break-inside: avoid; } .contents a { color: var(--ink); text-decoration: none; }
.kpi { border: 0; border-radius: 18px; background: #fff; box-shadow: 0 1px 2px rgba(20,40,70,.06), 0 4px 14px rgba(20,40,70,.05); padding: 14px 16px; }
.kpi-label { text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 600; }
.kpi-value { font-weight: 700; }
.summary { border-left: 0; padding: 16px 22px; background: var(--warm); box-shadow: none; }
.card { padding: 16px 22px 10px; margin-bottom: 16px; }
.card h2 { display: inline-flex; background: var(--tint); color: var(--tint-ink); border-radius: 999px; padding: 5px 14px; font-size: 14.5px; font-weight: 700; }
.card h2::before { width: 8px; height: 8px; border-radius: 50%; }
.tile { border-radius: 14px; background: var(--zebra); }
th { text-transform: none; letter-spacing: 0; font-size: 11px; border-bottom: 1px solid var(--rule); }
tbody tr:nth-child(even) td { background: var(--zebra); }
tbody tr td:first-child { border-radius: 8px 0 0 8px; } tbody tr td:last-child { border-radius: 0 8px 8px 0; }
td { border-bottom: 0; }
.bar { border-radius: 999px; }
.commentary { border-left: 0; border-radius: 16px; background: var(--warm); padding: 12px 18px; }
.commentary .label { text-transform: none; letter-spacing: 0; font-size: 12.5px; color: var(--tint-ink); }
.about { padding: 16px 22px; }
@media print {
  .contents, .summary, .card, .about, .kpi { box-shadow: none; border: 1px solid var(--rule); }
  .summary, .commentary { border: 0; }
  .cover { padding: 20px 24px 18px; border-radius: 18px; }
  .card { padding: 12px 18px 6px; margin-bottom: 12px; } .card h2 { font-size: 13px; padding: 4px 12px; }
}
@media (max-width: 640px) { .contents ol { columns: 1; } }
`;

export const ONEPAGE_CSS = String.raw`.card { padding: 10px 16px 6px; margin-bottom: 10px; } .cover { padding: 16px 20px 14px; }
`;
