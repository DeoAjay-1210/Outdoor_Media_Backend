# Report Analytics — verified mappings and limitations

Read-only. Endpoints (all `POST`, JWT required, roles 1–4 only — role 5 and missing roles get 403):

| Endpoint | Chart |
|---|---|
| `/admin/report-analytics/filters` | media types, cities, financial years |
| `/admin/report-analytics/payments` | 1 Payment analytics |
| `/admin/report-analytics/media` | 2 Sites onboarded per month |
| `/admin/report-analytics/appraisal` | 3 Appraisals |
| `/admin/report-analytics/upcoming-bills` | 4 Generated bills |
| `/admin/report-analytics/gst` | 5 GST |
| `/admin/report-analytics/tds` | 6 TDS |

Request body: `{ fy?: 2026, startDate?: "YYYY-MM-DD", endDate?: "YYYY-MM-DD", mediaType?, city? }`.
A custom range wins over `fy`; with neither, the current financial year (1 Apr – 31 Mar) is used.
Ranges of 62 days or fewer are bucketed by day, longer ones by month (`YYYY-MM`). Buckets are
zero-filled so axes are continuous. Max span 5 years.

Response: `{ success, statusCode, message, data: { filters, buckets[], summary, meta } }`.
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
(the codebase has two different split rules, see audit F-035/F-044). Filter values are exact trimmed
strings; `Hoarding` and `hoarding` are listed separately.

**Sites onboarded** — counts distinct `MediaOnboarding` documents by `MediaOnboarding.createdAt`.
- A site is counted once, however many faces (`mediaDetails[]`) it has; multiple faces never inflate
  the total. (Note: dashboard v2 `totalSites` counts faces — a different unit.)
- With no filter every site in the period is counted. With a media type and/or city selected, a site is
  counted when at least one single face satisfies all selected filters (type **and** city on the same
  face). A Hoarding + Pole Board site counts once overall, once under Hoarding and once under Pole Board.
- Values are matched as exact trimmed strings; distinct stored values are not merged.
- The monthly buckets and `summary.total` use the same filtered definition, so the buckets always add up
  to `summary.total`. The frontend plots `buckets[].total` and shows `summary.total` in the card.
- `byType` (per bucket and in `summary`) is informational: distinct sites having a face of each type
  (restricted to matching faces when filtered). A mixed-type site appears under each of its types, so
  these numbers can overlap and are not meant to sum to `total`.
- Sites without a usable `createdAt` are never given a date; they are counted once each in
  `meta.sitesWithoutOnboardingDate` (only sites that pass the media type / city filter).

**Appraisal** — `appraisal.history[]`. The onboarding/update code pre-schedules future rows
(`autoScheduleFutureAppraisalEntries`), so *upcoming* = stored rows dated after today; nothing is projected.
Anchor rows (`isAnchorEntry`) and rows with `appraisalAmount ≤ 0` are skipped. The `appraisalHold`
schema comment contradicts itself; the code (`appraisalHold !== 1` gates auto-apply, hold switches
`applicable` to 0) shows **1 = on hold**. Held sites: rows on/after `appraisalHoldDate` (or after today
if no hold date) are classified *On hold*, not given/upcoming. Sites with `applicable ≠ 1` that are not
held are skipped. Hold can also be recorded per bill (`AppraisalHoldController`); that bill-level state
is not used here.

**Generated bills** — `rentalDue[]`, by `dueDate`. Verified in `computeGstSplit`: `baseAmount` is the
**gross** (rent + GST), `gstAmount` the GST part, `netPayable` what is payable to the owner now (rent for
`withGst` 0/1, rent + GST for 2). Statuses are the existing `approvalStatus` (1 Pending, 2 Partially
approved, 3 Approved, 4 Overdue); no paid state is inferred. Nothing is generated.

**GST** — business definitions applied to stored data:
- *Hold*: `gstBalanceHistory` rows with `isPaid=false` (GST of a `withGst=1` bill kept until the landlord
  submits the receipt), by bill due date. The schema comment calling this "remitted to govt" is
  superseded by the confirmed business meaning.
- *Paid*: `gstBalanceHistory` rows with `isPaid=true`, by `paidAt` (fallback `date`).
- *Unpaid*: `rentalPayment.gstOutstandingHistory` rows with `isPaid=false`, minus `paymentBreakup`,
  by `dueMonth`.
- *Future*: `rentalDue[].gstAmount` for generated bills dated after today, excluding bills already in
  `gstBalanceHistory` or flagged `gstAddedToBalance`/`ownerGstAddedToBalance`.
- Rental-level and owner-level `gstBalanceHistory` rows can describe the same bill; where owner-level rows
  exist the rental-level row is ignored.

**TDS** — `tdsBalanceHistory[]` (written by `ledger-save` with `withTds=1`), bucketed by `paidAt` →
`date` → `cycle`. `tdsAmount` and `paidAmount` are the same figure and are not summed; rows are
de-duplicated per owner + `dueMonth`. `landOwners[].tdsAmount` is a standing per-bill figure, not a
deduction event, so it is not added. No hold category is introduced.

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
