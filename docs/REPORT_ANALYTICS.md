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
| `/admin/report-analytics/tds` | Source-specific TDS (Rental Master or Ledger) |
| `/admin/report-analytics/tds-status` | 6 TDS chart: source-specific totals, paid deductions and bill statuses |

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

**TDS chart (`/tds-status`).** Total TDS and its monthly buckets, details, entries and site counts come from
`computeTdsRentalMaster` (Rental Master generated bills, by bill due date). Paid TDS and its monthly buckets,
details, entries and site counts come from `computeTds` (`tdsBalanceHistory`, by Ledger deduction date). Due and
Upcoming remain the status calculation over stored Rental Master bills: upcoming is an unpaid configured TDS
amount on a bill due after today; due is unpaid TDS due today or earlier. The chart does not project unstored
bills. Since the independent series use their source's existing date rules, the monthly Paid series can fall in
a different month from its corresponding bill, and Total need not equal the sum of the plotted status series.
Filters (period, site status, media type and city) are applied to all three calculations before the response is
built. The `/tds` endpoint remains the source-selectable Rental Master or Ledger detail/chart calculation.

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
held are skipped. A bill's `appraisalHold.hold` and its release timestamp determine its active hold;
an earlier active hold carries to later bills that are not CMD-approved unless the later bill's release
is newer than that hold. A dated appraisal is *Paid* only if its same-month bill is fully approved
(including an explicit approved CMD step whenever detailed approval steps exist), no effective hold
blocks it, and the Ledger cycle calculation reports no unpaid rent for that same site and month. A
legacy bill with no detailed approval steps retains the existing overall-approved status rule.
Otherwise, an incomplete or unmatchable approval/bill is *Hold*, while an approved, unheld appraisal
without full payment is *Unpaid*. Future stored rows are *Upcoming* unless an active hold applies.

- **Payment-based cycle summary** (`summary` / `buckets`): one unit per site × billing-month cycle, from
  `getAllDueCycles`; the cycle date is selected inclusively by the requested range. Future cycles come from the
  billing schedule; `notYetBilled` counts those without a bill row.
- remaining = `getOverallSummaryForCycle(site, month)`: `currentMonthRentPending` (landlord shares without a
  qualifying ledger row for that month + mode; direct GST rides with rent) + `currentMonthGstPending` (held GST not
  released through `gstBalanceHistory`). Remaining = 0 → settled and excluded. These are actual cycle outstanding
  amounts, not the generated-bill amounts shown on the approval cards.
- category vs today (IST day): `upcoming` / `dueToday` / `overdue` (before today, remaining > 0). This is
  payment-based overdue; Rental Master's approval-based Overdue is a different metric.
- `summary.total` = upcoming + dueToday + overdue (amount, cycles; sites distinct across them).
- `summary.unallocated`: cycles of sites with no landlord or no active face are listed with ledger remaining and
  configured rent, outside the total. Opening balances are not billing cycles.
- media type / city for these site-cycle records are site-level; mixed sites are excluded from filtered views.
- This cycle summary reconciles with the Rental Master cycle calculation (`computePeriodDue(...).due.unpaid`),
  not with Rental Master's Total Due This Month or the approval cards.
- **Approval-card view** (`approvals` / `billRecords`): `computeRentalMasterApprovals` uses
  `computePeriodDue`'s authoritative period-demand iterator, the same as the Payments endpoint.
  Total includes Rental + direct GST + hold GST, plus opening balances once; stored bill `baseAmount`
  is never used to price these cards. Billing-cycle months follow Payments, capped at the current month.
- Approved and Pending partition that period demand using `computeRentalDueStats` face/site approval
  selection. Single-bill sites use the most-progressed active-face approval; separate bills keep face
  statuses. Status 2 alone is not approved. Payments do not change workflow approval classifications.
- Opening balances have no approval workflow: by the explicitly agreed rule, paid (`isPaid` or UTR)
  openings are Approved and unpaid openings Pending. This classification does not create approval records.
- Past Overdue preserves Rental Master's approval-based all-cycle definition through the selected end
  month: unapproved previous cycles, current-month past-due allocations (including the status-3 override),
  plus unpaid past-due openings. Approved-but-unpaid cycles are excluded. Earlier-period overdue is outside
  Total/Approved/Pending; do not add it to Total. The monthly bars show only selected-period categories.
- Amounts are split equally across active faces as in Rental Master, with cumulative cent rounding to
  conserve rent and GST. Detail rows are face-cycle allocations or opening balances, not stored bills.
  Earlier-period overdue rows carry `generated: false`, `approved: false`, `pending: false`, `pastDue: true`.
- Active-site status, city and media filters match Payments. Media/city are site-level; mixed sites are
  excluded from a filtered view instead of assigning an arbitrary valuation to a face type.
- The legacy top-level payment-based `summary` / `records` remain unchanged. The frontend uses
  `approvals.summary` and `billRecords`, including when the legacy payment summary is settled/empty.
- `computeBillApprovals` and `computeBills` remain available for legacy stored-bill tests only.
**Report export** (frontend, `analytics_export_*.dart`): Export (top right of the page) → Excel (.xlsx) or PDF.
It re-fetches all six endpoints with the filters active at the click (outstanding with `details: true`) and
writes every section in full — Summary (filters, generation date, key figures, data sources), outstanding cycles,
monthly trend, status / media-type breakdowns, site and bill details, unallocated cycles, payments, sites
onboarded, appraisals, GST, TDS and TDS lines. Nothing is recalculated: values are the API's; totals rows are
SUMs of the rows shown, and non-additive columns (distinct sites) carry the API's figure. Excel has native charts
bound to the sheet cells, ₹ Indian-grouped formats, frozen headers and filters; the PDF (landscape A4, repeated
table headers, page numbers) writes amounts as "Rs." because the built-in PDF fonts have no ₹ glyph.
Sections the chosen source does not support (Ledger: outstanding, appraisals) are left out and noted in Summary.

### Chart date granularity

- Payment balances, Ledger GST classifications and Rental Master Outstanding are billing-cycle amounts,
  not daily transaction activity or historical outstanding snapshots. They retain monthly buckets even
  when the selected range covers one day. Their Rental Master calculation rules are unchanged.
- The Payment chart's optional **Payment dates** view uses the existing `payments` endpoint with
  `source: ledger`: deduplicated `ledgerHistory` payments grouped by their actual `date`. It does not
  move unpaid cycle balances onto payment dates and does not change the cycle-based KPI cards.
- The combined `tds-status` chart now honors the requested short-range daily granularity: Total/Due/
  Upcoming use bill due dates, and Paid uses recorded deduction dates. Longer ranges remain monthly.
  Its KPI definitions and amounts are unchanged. Legacy source-only TDS functions retain monthly
  defaults for their existing callers; the combined chart requests its appropriate granularity.
- Sites onboarded and appraisals already honor short-range daily buckets (`createdAt` and appraisal
  effective/revision dates respectively). Agreements remain monthly state snapshots, not expiry events.
- Monthly labels use a full year (e.g. **Oct 2026**) to distinguish them from daily **26 Oct** labels.
  Missing transaction breakdowns are explained rather than supplied with artificial dates or amounts.

The Outstanding Payments cards now use `computeRentalMasterApprovals`. The stored-bill description below
explains legacy bill/GST storage, not the current Outstanding card valuation.

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
- Amount comes from `paidAmount`, falling back to `tdsAmount` for older rows; the two fields are never
  summed. Dated by `paidAt` → `date`; `cycle` is the bill cycle, not the deduction date, and is not used
  to place or filter a Paid TDS deduction. Rows are de-duplicated per landlord + bill month (`dueMonth`
  normalised, so `Jun 2026` = `June 2026`; latest wins). Local `landOwners._id` and
  `landOwnerMasterId` aliases resolve to the same landlord; a unique name is used only as a legacy
  fallback. Rows with no deduction date are reported in `meta.recordsWithoutDate`, not assigned to a
  bill-cycle month.
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

## Shared UI / Excel / Power BI reporting contract

The frontend mapping and export schema are documented in `../Outdoor_Media_frontend/docs/REPORTING_CONTRACT.md`. All financial computations remain in this backend. Detail responses now include the stored root Site Code (or null), and payments with source=ledger and details=true include the same deduplicated, dated payment records used in their summary. The response without details keeps its previous shape. These are read-only reporting additions; no billing-generation route or financial record write is involved.
