# Report Analytics — verified mappings and limitations

Read-only. Endpoints (all `POST`, JWT required, roles 1–4 only — role 5 and missing roles get 403):

| Endpoint | Chart |
|---|---|
| `/admin/report-analytics/filters` | media types, cities, financial years |
| `/admin/report-analytics/payments` | 1 Payment analytics |
| `/admin/report-analytics/media` | 2 Sites onboarded per month |
| `/admin/report-analytics/appraisal` | 3 Appraisals |
| `/admin/report-analytics/upcoming-bills` | 4 Outstanding payments (formerly "Upcoming payments" / "Generated bills") |
| `/admin/report-analytics/gst` | 5 GST |
| `/admin/report-analytics/tds` | 6 TDS |

Request body: `{ source?: "rentalMaster" | "ledger", siteStatus?: "active" | "inactive" | "all", fy?: 2026, startDate?: "YYYY-MM-DD", endDate?: "YYYY-MM-DD", mediaType?, city? }`.
`source` defaults to `rentalMaster`; any other value is a 400. `siteStatus` (`active` | `inactive` | `all`,
default `all` when absent; the frontend sends `active` by default) keeps only active sites — at least one face with
`mediaDetails.status === 1`, the dashboard's rule — or only the others (faces inactive / on hold), before any chart
is computed (`applySiteStatus`); it is echoed in `filters.siteStatus` and the frontend refuses a response without it. A custom range wins over `fy`; with neither, the
current financial year (1 Apr – 31 Mar) is used. Ranges of 62 days or fewer are bucketed by day, longer ones by
month (`YYYY-MM`); Payments (Rental Master) and TDS are always monthly. Buckets are zero-filled. Max span 5 years.

Frontend periods (one shared filter for all six charts): **current calendar year (default)**, previous
calendar year, current / previous financial year, custom range (small popover calendar). Financial years are
sent as `fy`; calendar years (1 Jan – 31 Dec) and custom ranges as an inclusive `startDate`/`endDate`, so the
server needs no calendar-year logic of its own and the two year types never mix.

Response: `{ success, statusCode, message, data: { filters, buckets[], summary, meta, supported } }`.
`filters.source` echoes the source used; the frontend rejects a response whose source differs from the one it
asked for, so a server that ignored `source` can never put one source's numbers under the other's label.

## Data-source filter (Rental Master / Ledger)
Sources are never mixed and never fall back. Support per chart (`SELECT[chart][source]` in the controller):

| Chart | Rental Master | Ledger |
|---|---|---|
| Payments | Rental Master cycle calculation (`computeRentalMasterPayments`): to be paid / paid / unpaid per bill-cycle month | `ledgerHistory` cash / online entries by payment date (`computePayments`) |
| Sites onboarded | `createdAt` — **same for both** (not a Rental Master or Ledger figure; response `sourceIndependent: true`) | same |
| Appraisals | `appraisal.history` | **not supported** — `supported: false` + reason, no query |
| Generated bills | `rentalDue` | **not supported** — `supported: false` + reason, no query |
| GST | `rentalDue[].gstAmount` by due date (direct = withGst 2, otherwise hold-type) + onboarding GST dues | Ledger Entry's GST calculation (`computeLedgerGst`): expected GST per bill cycle, paid / remaining, by cycle month |
| TDS | configured TDS of TDS-applicable landlords per generated bill (`computeTdsRentalMaster`) | `tdsBalanceHistory` recorded deductions (`computeTds`) |

**Payments, Rental Master.** The same `computePeriodDue` figures as before (reconciles with Rental Master's
"Total Due This Month"), now also per bill-cycle month: to be paid, unpaid, paid = to be paid − unpaid (the paid
status Rental Master itself shows, which it derives from ledger rows). No ledgerHistory amounts or payment dates.
Cycles after today are not projected. Cycle inclusion is by month (a cycle on 5 Jun counts for a range starting
10 Jun), as before. **Payments, Ledger** shows no due/unpaid cards (those are Rental Master figures).

**TDS, Rental Master.** TDS applicability is `landOwners[].tdsApplicable === 1`; the amount is the configured
per-bill `landOwners[].tdsAmount` (the same field the dashboard's "TDS this month" and the ledger's pending TDS
rows use). For every generated bill (`rentalDue`, one per site per due month — the approved row, else the latest
updated, because landowner TDS is per site even when faces are billed separately), dated by the bill's `dueDate`:
each owner from `landOwnersAsOfDate(doc, dueDate)` (amounts scaled to the rent in force before a later
appraisal) with `tdsApplicable === 1`, not on a CMD TDS hold (`tdsHold === 1`), and `tdsAmount > 0`. Owners on
hold and applicable owners without an amount are counted in `meta`, never computed from `tdsPercentage`.
Limitation: Rental Master keeps only the *current* TDS settings, so older bills show today's applicability.
This is TDS *applicable on bills*, not TDS *deducted* — that is the Ledger view.

### Data-source labels
Each chart shows "Data source: …" (frontend `AnalyticsSources`, per source). They name the top-level fields
read by the chart's projection; `test/reportAnalytics.test.js` pins those roots per chart and source, so a
projection change fails the test until the label is re-checked.

| Chart / source | Projection roots (besides `mediaDetails` for filters/names) |
|---|---|
| Payments / Rental Master | `ledger`, `ledgerHistory` (paid state), `landOwners`, `appraisal.history`, `rentalDue`, `rentalPayment`, `gstBalanceHistory`, `gstApplicableFlag` |
| Payments / Ledger | `ledgerHistory` |
| Sites onboarded / both | `createdAt` |
| Appraisals / Rental Master | `appraisal` |
| Generated bills / Rental Master | `rentalDue` |
| GST / Rental Master | `rentalDue`, `rentalPayment.gstOutstandingHistory` |
| GST / Ledger | same as Payments / Rental Master (the Ledger Entry cycle calculation) |
| TDS / Rental Master | `rentalDue`, `landOwners` (tdsApplicable, tdsAmount, tdsHold, name), `rentalPayment.totalRentalAmount`, `appraisal.history` |
| TDS / Ledger | `tdsBalanceHistory` |

`meta` lists rows that were left out (no date, no amount, duplicates, mixed-type sites).

Code: `utils/reportAnalytics.js` (pure functions), `controllers/Admin/ReportAnalyticsController/`,
`routes/Admin/ReportAnalyticsRoutes/`, tests in `test/reportAnalytics.test.js`.

## Dates
Stored dates are read with UTC getters (the codebase stores many timestamps as IST wall-clock in a
UTC `Date`). "Today" is `nowIST()`.

## Verified mappings

**Payments** — `ledgerHistory[].months[].entries[]`, `date` = payment date, `amount`, `paymentMode`.
`ledger-save` writes each payment to the live `ledger` / `withGst1Ledger` *and* appends it to
`ledgerHistory`; the live arrays are cleared when the cycle advances (`advanceRentalPaymentOnOwnerApproval`).
Only `ledgerHistory` is read, so nothing is double counted. A re-save upserts the live row but appends a
new history row, so history rows are de-duplicated by owner + mode + `withGst` + bill + slot (latest wins).
`amount` is an optional caller-supplied field: rows with `amount ≤ 0` cannot be valued and are reported in
`meta.entriesWithoutAmount`, not guessed.

**Media type / city** — stored per face (`mediaDetails[]`); money is stored per site. A site is attributed
to a media type / city only when all its faces agree. Sites whose faces disagree are *excluded* from
filtered views and reported in `meta.excludedMixedSites` — amounts are never split between faces
(the codebase has two different split rules, see audit F-035/F-044). Exception: Generated bills, whose rows
are stored per face (below). Media types are compared trimmed with inner whitespace collapsed
(`mediaTypeText`) — faces, bills, filter options and the filter value alike; case is kept, so `Hoarding` and
`hoarding` are listed separately.

**Sites onboarded** — counts media **faces** (`mediaDetails[]`) by the parent `MediaOnboarding.createdAt`,
the same unit as the dashboard's `totalSites` / `activeSites` / `inactiveSites`.
- Every face counts once; `status` 1 = active, anything else = inactive. A document with no faces counts
  once, as inactive (never under a media type / city filter).
- Site status (Active / Inactive / All) is applied **per face** here (the endpoint passes unfiltered
  documents). The other charts keep the site-level rule (a site is active when any face is active).
- Media type / city: a face counts when it matches every selected filter itself.
- Buckets and `summary.total` use the same definition, so they always add up. `summary.byType` counts
  faces per type ("Unspecified" when blank) and sums to `total`. `summary.sites` (new) = distinct site
  documents behind the counted faces.
- **Limitation:** `createdAt` is a property of the site document, not of a face, so a face added later is
  dated with the site's creation, and imported/back-filled records share the import date. The trend shows
  when site records were created, not when faces went live.
- Records without a usable `createdAt` are never given a date; they are reported in
  `meta.sitesWithoutOnboardingDate` (documents) and `meta.facesWithoutOnboardingDate` (faces, new), only
  those that pass the filters.

**Appraisal** — `appraisal.history[]`. The onboarding/update code pre-schedules future rows
(`autoScheduleFutureAppraisalEntries`), so *upcoming* = stored rows dated after today; nothing is projected.
Anchor rows (`isAnchorEntry`) and rows with `appraisalAmount ≤ 0` are skipped. The `appraisalHold`
schema comment contradicts itself; the code (`appraisalHold !== 1` gates auto-apply, hold switches
`applicable` to 0) shows **1 = on hold**. Held sites: rows on/after `appraisalHoldDate` (or after today
if no hold date) are classified *On hold*, not given/upcoming. Sites with `applicable ≠ 1` that are not
held are skipped. Hold can also be recorded per bill (`AppraisalHoldController`); that bill-level state
is not used here.

**Outstanding payments** (endpoint `upcoming-bills`, `computeOutstanding`) — one unit per **site × billing-month
cycle** (several face bills never repeat a site's amount), from the Rental Master / Ledger cycle calculation:
- cycles = `getAllDueCycles` on the site without its stale rows (`isStaleBill`), one per month; the cycle date is the
  due date; only cycles due within [start, end] (inclusive) count. Future cycles come from the billing schedule —
  `notYetBilled` counts those without a bill row.
- remaining = `getOverallSummaryForCycle(site, month)`: `currentMonthRentPending` (landlord shares with no ledger
  entry for that month + mode — the ledger's binary paid rule, `isOwnerModePaidForCycle`; direct GST rides with rent)
  + `currentMonthGstPending` (held GST not yet released through `gstBalanceHistory`). remaining = 0 → settled,
  excluded (`meta.settledCycles`), whatever the approval status.
- category vs today (IST day): `upcoming` (after today) / `dueToday` / `overdue` (before today, remaining > 0). This
  overdue is **payment-based**; the Rental Master / dashboard Overdue is approval-based (not fully approved, past due).
- `summary.total` = upcoming + dueToday + overdue (amount, cycles; sites distinct across them).
- `summary.unallocated`: cycles of sites with no landlord (rent not computable) or no active face — listed with the
  ledger's remaining and the configured rent, **outside the total** until their treatment is decided.
- status of a cycle = least advanced approval status of its current-face bill rows ("Not billed yet" without rows);
  media type / city are site-level (mixed sites leave filtered views). Opening balances are not cycles: not included.
- Reconciles with Rental Master: for a month, total + unallocated remaining (+ opening unpaid of that month) =
  `computePeriodDue(...).due.unpaid`.
- Export details (opt-in, `details: true` in the body — sent only by the page's Excel / PDF export): adds
  `records[]`, one row per outstanding cycle of the total (site, media codes, city, media type, due date, month,
  category, status, rent / gst / remaining) with its current-face bill rows (`bills[]`: bill id, media code,
  due date, base / GST / net payable as stored, approval status). Same calculation and filters as the summary:
  the remaining of the records adds up to `summary.total.amount`; stale rows are never listed. Without the flag
  the response is unchanged.

**Report export** (frontend, `analytics_export_*.dart`): Export (top right of the page) → Excel (.xlsx) or PDF.
It re-fetches all six endpoints with the filters active at the click (outstanding with `details: true`) and
writes every section in full — Summary (filters, generation date, key figures, data sources), outstanding cycles,
monthly trend, status / media-type breakdowns, site and bill details, unallocated cycles, payments, sites
onboarded, appraisals, GST, TDS and TDS lines. Nothing is recalculated: values are the API's; totals rows are
SUMs of the rows shown, and non-additive columns (distinct sites) carry the API's figure. Excel has native charts
bound to the sheet cells, ₹ Indian-grouped formats, frozen headers and filters; the PDF (landscape A4, repeated
table headers, page numbers) writes amounts as "Rs." because the built-in PDF fonts have no ₹ glyph.
Sections the chosen source does not support (Ledger: outstanding, appraisals) are left out and noted in Summary.

`computeBills` (stored bill rows by timing — upcoming / dueToday / overdue / pastApproved) is kept and tested but no
longer served. Its former panel showed `summary.upcoming` /
`buckets[].upcoming`: stored bills whose `dueDate` is in the selected period **and after today** (today = the IST
calendar day, `nowIST`, the convention of the stored due dates). Cards, donut (status / media type, count / amount),
monthly chart and tooltips all use those rows. `summary.overdue` = due before today and not fully approved
(`approvalStatus ≠ 3`, the Rental Master / dashboard rule in `rentalDueStats`) — its own card, never upcoming.
`summary.dueToday` (neither upcoming nor overdue yet) and `summary.pastApproved` complete the partition; the
top-level `summary` / bucket fields are still *all stored bills in the period* (= the four parts). The old "Overdue"
card read stored `approvalStatus` 4, which no code sets.

**Stored bills** — `rentalDue[]`, by `dueDate`. Verified in `computeGstSplit`: `baseAmount` is the
**gross** (rent + GST), `gstAmount` the GST part, `netPayable` what is payable to the owner now (rent for
`withGst` 0/1, rent + GST for 2). Statuses are the existing `approvalStatus` (1 Pending, 2 Partially
approved, 3 Approved, 4 Overdue); no paid state is inferred. Nothing is generated.
- **Media type is per bill** (`billMediaType`): `rentalDue` rows are stored per face (`mediaDetailId`) — a
  separate-bill face has its own bill, and a single-bill multi-face site stores one row per face holding that
  face's sqft share of the site bill (`computeGstSplit(…, faceId, …)`, `siteBillForOverdue`). So a row takes the
  type of the face its `mediaDetailId` matches (also when that face is inactive now). Only a row without a face,
  is classified at site level from the site's **active** faces (all faces if none is active) — "Mixed types" only
  when those disagree.
- **Stale rows are excluded** (`isStaleBill`): a row whose `mediaDetailId` names no face of the site (face deleted
  or re-created with a new id) only duplicates the row the billing code then creates for the current face; Rental
  Master already ignores such rows (`rentalDueStats.pickFaceEntry`). They are dropped before every output (total,
  counts, sites, buckets, status / type breakdowns) and reported in `meta.staleRowsExcluded` { bills, amount, sites }
  for the period. Rows without a `mediaDetailId` are site-level bills and always count; rows of an existing but
  inactive face are not stale. On the dev data: 52 such rows (all pending, each with a current-face row for the same
  month; none referenced by ledger / GST / TDS records), 34 of them (₹11,06,534) in October 2026.
- The media-type filter uses the same per-bill type, so a multi-type site's matching faces are included; only
  genuinely mixed site-level rows are excluded (`meta.excludedMixedSites`). City filtering stays site-level.
- Previously every row of a multi-type site was "Mixed types" (on the dev data: one 12-face site, 24 rows —
  now Hoarding 6, Digital 8, Unipole 4, Wall Hoarding 6). Counts and amounts are unchanged.

**GST** — business definitions applied to stored data, split by source (never mixed):
- Ledger = **Ledger Entry's "GST Hold (This Month)" / "GST Hold (Past Months)" cards**, month by month
  (`computeLedgerGst`, reconciled in tests against `calculateNewOverallLedgerSummary`). Per bill cycle up to the
  current month: *due* = the cycle's expected GST (`resolveExpectedGstForCycle`, appraisal-aware; owner GST for
  direct-GST cycles), *paid* = `gstBalanceHistory` rows for that due month that are paid **or carry a UTR**
  (deduped as the ledger does, capped at the expected amount; direct GST is paid with the owner's rent),
  *remaining* = due − paid. Plus onboarding `rentalPayment.gstOutstandingHistory` rows by `dueMonth` (paid = isPaid
  or UTR). Split into held / direct / onboarding. Sites without an active face are skipped. Always monthly, by
  cycle month (paid is attributed to the cycle, as on Ledger Entry, not to the payment date).
- **Why Ledger GST used to be empty:** it read `gstBalanceHistory` rows only. Those rows are created when a
  GST-hold bill is approved in Rental Master (`gstAddedToBalance`) or when the GST is paid in the ledger, so cycles
  whose bills were never approved have no row — yet Ledger Entry shows their GST as held, because it starts from
  the *expected* GST. It also treated UTR-only rows as held and used a different placeholder dedupe.
- Ledger Entry's "Past Months" spans every earlier cycle; a calendar / financial year only covers its own months.
  To compare totals choose a custom range from the first billing month to today. Future cycles are not shown.
- Rental Master, *Direct* / *Hold-type*: `rentalDue[].gstAmount` of generated bills by `dueDate`
  (`withGst=2` = paid with the rent; otherwise held until the receipt — the ledger's own classification).
  All generated bills, past or future-dated; nothing projected; paid status not inferred.
- Rental Master, *Unpaid dues*: `rentalPayment.gstOutstandingHistory` rows with `isPaid=false`, minus
  `paymentBreakup`, by `dueMonth`.
- (The former mixed "Future" category is gone: generated future-dated bills are part of the Rental Master view.)

**TDS (Ledger)** — `tdsBalanceHistory[]` (written by `ledger-save` with `withTds=1`: one row per owner + bill
month, upserted, so each row is an individual deduction and never a running balance).
- Only recorded deductions count: rows with `isUtrEntry` falsy are what the ledger treats as pending
  TDS and are skipped (`meta.pendingIgnored`).
- Dated by `paidAt` (the entry date) → `date` → `cycle`. `tdsAmount` and `paidAmount` are the same figure
  and are not summed. Rows are de-duplicated per owner + bill month (`dueMonth` normalised, so
  `Jun 2026` = `June 2026`; latest wins).
- **Always bucketed by month**, whatever the range length (other charts switch to days for ≤ 62 days).
  Rows outside the selected range are excluded even inside a partially covered month.
- Each bucket carries `deductions[]` — `{ id, date (YYYY-MM-DD), amount, billMonth, siteId, siteName,
  mediaCodes[], mediaType, city, ownerName, utrNumber }` — the exact rows behind its amount, sorted by date.
  The frontend shows them when a month is clicked, so the breakdown always comes from the same request
  (same shared filters) as the bar and the totals. `summary.owners` / bucket `owners` count distinct
  site + owner pairs.
- `landOwners[].tdsAmount` is a standing per-bill figure, not a deduction event, so it is not added.
  No hold category is introduced.

## Unresolved assumptions / limitations
1. **Unpaid GST on generated direct-GST bills** (`withGst=2`) is *not* reported: paid state lives in ledger
   rows keyed by owner + mode + month and the client/server "paid" definitions diverge (F-035).
   "Unpaid" is therefore limited to onboarding GST balances. Needs a business-approved rule.
2. **TDS completeness**: only deductions recorded through `withTds=1` appear. TDS deducted without such a
   record (if any) is invisible.
3. **Legacy payments without `amount`** are listed in `meta` but cannot be charted.
4. **Appraisal hold dates**: sites held without `appraisalHoldDate` use "after today" as the boundary.
5. For the Sites-onboarded chart, a media type + city filter requires both on the same face; if the
   business wants "any face has the type AND any face is in the city", the rule needs changing.
   `createdAt` is assumed to be the onboarding date (it is the only creation date on the document).
6. Dashboard `allowedRole` admits role 5; analytics deliberately admits 1–4 only. Not changed there.
7. Aggregation reads the full collection with a field projection (as dashboard v2 does); very large
   datasets may later need a `$match`/aggregation-pipeline rewrite or caching.
