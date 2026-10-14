# Example Co

**example.com** · Technical SEO report · September 2026 (1–30 Sep 2026)  
Compared with August 2026 · Generated 13 Oct 2026 · *Data-only report*

## Technical SEO issues

| Critical | High | Medium | Low | New | Resolved |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **1** | **2** | **3** | **2** | **2** | **1** |

**Critical**

| Issue | Pages | Example | Found by | Change |
| --- | ---: | --- | --- | --- |
| Buttons must have discernible text | 1 | /contact | Audit | *still open* |

**High**

| Issue | Pages | Example | Found by | Change |
| --- | ---: | --- | --- | --- |
| Broken internal link | 4 | /services | Site crawl | *new* |
| Page is not indexed | 1 | /old-offer | Audit | *still open* |

**Medium**

| Issue | Pages | Example | Found by | Change |
| --- | ---: | --- | --- | --- |
| Page has no title | 1 | /thanks | Site crawl, Audit | *new* |
| Duplicate title tags | 6 | /blog/page/2 | DataForSEO crawl | *still open* |
| Google chose a different canonical than the page declares | 1 | /pricing | Audit | *not re-checked* |

**Low**

| Issue | Pages | Example | Found by | Change |
| --- | ---: | --- | --- | --- |
| Page in a sitemap with no internal links to it | 1 | /landing/spring | Site checks | *still open* |
| An AI search crawler is blocked | 1 | / | Site checks | *still open* |

**Resolved since the last report**

| Issue | Example | Found by |
| --- | --- | --- |
| Redirect chain | /old-blog | Site crawl |

*From Audit (9 Oct 2026), Site crawl (11 Oct 2026), Site checks (9 Oct 2026), DataForSEO crawl (20 Aug 2026, older data). The same problem found by several sources is listed once; "Pages" is the largest count any one source reports. Issues not re-checked by their source are shown as not re-checked, never as fixed.*

## Google indexing

| URLs checked | Indexed | Not indexed | Canonical chosen differently |
| ---: | ---: | ---: | ---: |
| **40** | **31** | **9** | **2** |
|   | 77.5% of checked |   |   |

**Google's verdict for checked URLs**

| Google says | URLs |
| --- | ---: |
| Submitted and indexed | 31 |
| Crawled - currently not indexed | 4 |
| Discovered - currently not indexed | 2 |
| Duplicate, Google chose different canonical than user | 2 |
| Page with redirect | 1 |

**Pages to look at**

| Page | Google says | In sitemap | Last crawled |
| --- | --- | --- | --- |
| /services/old | *high* Not found (404) | yes | 2 Oct 2026 |
| /blog/spring-tips | *medium* Crawled - currently not indexed | yes | 21 Sep 2026 |
| /pricing | *medium* Duplicate, Google chose different canonical than user (Google's canonical: /plans) | yes | 5 Oct 2026 |
| /tag/news | *medium* Discovered - currently not indexed | no | never |

**Sitemaps**

| Sitemap | Errors | Warnings | URLs submitted |
| --- | ---: | ---: | ---: |
| `https://example.com/sitemap.xml` | 0 | 1 | 118 |
| `https://example.com/news-sitemap.xml` | 2 | 0 | 12 |

**Share indexed by month**

| Month | URLs checked | Indexed |
| --- | ---: | ---: |
| 2026-07 | 18 | 72.2% |
| 2026-08 | 25 | 76.0% |
| 2026-09 | 32 | 75.0% |
| 2026-10 | 40 | 77.5% |

*Based on Google's URL Inspection of 40 pages (key pages, top Search Console pages and a rotating sample of sitemap URLs), not Search Console's full Page indexing report. 5 key pages and 30 sitemap URLs (of about 120 submitted) were checked; the oldest result is 6 days old.*

## About this report

- Period: September 2026 (1–30 Sep 2026), compared with August 2026 (1–31 Aug 2026).
- Data-only report. Built automatically from Search Console and Google Analytics. It has no written commentary.
- Sources: Google Search Console (search), Google Analytics 4 (organic traffic), saved crawlmark audits, the Chrome UX Report and Google Tag Manager when those sections are included.
- Technical SEO issues: crawlmark's saved audits and crawls, a stored DataForSEO crawl and Google URL Inspection when available, merged into one list and compared with the previous report.
- Google indexing: Search Console's URL Inspection of a sample of pages and its sitemap report (free, read-only).

---
crawlmark 0.1.0
