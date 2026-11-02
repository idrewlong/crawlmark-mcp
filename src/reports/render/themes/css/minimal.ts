/** Minimal: no boxes or shading, thin rules, lots of white space. From the approved mockup; fonts come from the font block. */
export const CSS = String.raw`:root { --surface: #ffffff; --zebra: #ffffff; --tint: #ffffff; --rule: #e6e8eb; }
body { letter-spacing: .005em; }
.cover { background: #fff; color: var(--ink); border-radius: 0; border: 0; border-bottom: 1px solid var(--ink); padding: 8px 0 18px; margin-bottom: 26px; }
.cover .kind, .cover-meta dt, .subtitle, .domain, .badge { color: var(--muted); border-color: var(--rule); }
.cover h1 { font-size: 34px; font-weight: 300; letter-spacing: -.02em; }
.cover-meta { border-top: 0; padding-top: 14px; }
.contents, .summary, .card, .kpi, .about { background: transparent; border: 0; border-radius: 0; box-shadow: none; }
.contents { border-top: 1px solid var(--rule); padding: 14px 0; margin-bottom: 22px; }
.contents h2, .summary h2, .about h2 { color: var(--muted); font-weight: 500; letter-spacing: .14em; font-size: 10.5px; }
.contents a { color: var(--ink); text-decoration: none; }
.kpis { gap: 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); margin-bottom: 6px; }
.kpi { padding: 14px 16px 12px 0; } .kpi + .kpi { border-left: 1px solid var(--rule); padding-left: 16px; }
.kpi-value { font-weight: 300; font-size: 30px; }
.chip.good, .chip.bad, .chip.neutral { background: transparent; padding: 0; }
.summary { border-left: 0; padding: 18px 0 8px; margin-bottom: 18px; }
.card { border-top: 1px solid var(--ink); padding: 14px 0 6px; margin-bottom: 26px; }
.card h2 { color: var(--ink); font-size: 17px; font-weight: 400; letter-spacing: -.01em; }
.card h2::before { display: none; }
.pair { gap: 28px; }
.tile { background: transparent; border-top: 1px solid var(--rule); border-radius: 0; padding: 8px 0; }
th { border-bottom: 1px solid var(--ink); color: var(--muted); }
tbody tr:nth-child(even) td { background: transparent; }
.commentary { background: transparent; border-left: 1px solid var(--ink); border-radius: 0; padding: 4px 0 4px 16px; }
.commentary .label { color: var(--muted); font-weight: 500; letter-spacing: .14em; }
.tag { background: transparent !important; border: 1px solid currentColor; }
.about { border-top: 1px solid var(--rule); padding: 14px 0; }
@media print { .card { padding: 10px 0 4px; margin-bottom: 18px; } .kpi { padding: 10px 14px 8px 0; } .kpi + .kpi { padding-left: 14px; } .summary { padding: 12px 0 6px; } }
`;
