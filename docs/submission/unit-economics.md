# Conditional cost per accepted brief

This is a planning model, not a measured margin or a price recommendation. No paid customer or validated selling price is recorded.

## Cost definitions

Count all attempts needed to reach an operator-accepted export. Include rejected drafts, failed provider calls when billable, revisions, and human corrections. A successful Qloo query alone is not an accepted brief.

| Input | Current status | Evidence needed |
| --- | --- | --- |
| Revenue per brief or allocation from subscription | Unknown | Agreed paid scope and actual invoice or payment |
| Qloo fixed fee, minimum, unit rate, and allowance | Unknown | Project-specific written commercial terms |
| Qloo charge for failed requests | Unknown | Applicable usage statement and agreement |
| Model cost per attempt | Unknown | Configured model's applicable rate and measured billable units |
| Hosting and database allocation | Unknown | Actual incremental bill and reasonable allocation |
| Payment fees | Unknown | Selected payment method and actual terms |
| Human correction and support time | Unmeasured | Review worksheet, timed corrections, and loaded hourly cost |
| Accepted exports per period | Zero current accepted new generations in the v42 receipt | Current complete journeys with explicit operator acceptance and verified exports |

Let `Q` be the attributable Qloo cost, `M` the model cost, `H` the hosting allocation, `P` the payment fees, and `L` the correction and support labor. Let `A` be the number of accepted exports in the same cohort. Cost per accepted brief is `(Q + M + H + P + L) / A` when `A > 0`. When `A = 0`, report no observed accepted-brief unit cost. Do not replace that condition with a successful-query denominator.

For a proposed price `R`, contribution per accepted brief is `R - cost per accepted brief`. This excludes acquisition and fixed product-development costs unless explicitly allocated. Show those separately before making a profitability claim.

## Rights and pricing conditions

Qloo's public terms incorporate additional service terms, restrict resale and redistribution, and reserve fee changes. They do not establish this project's production allowance or permission to retain evidence and export it to clients. Confirm those permissions in the applicable agreement before selling the workflow. [Qloo terms](https://www.qloo.com/legal/terms).

Record permitted commercial use, API access, number of users, retention, client-facing exports, attribution, termination handling, and the actual price schedule. Separately check model terms and rights for any images, music, named works, or other production assets. An MIT code license does not supply those rights.

## Next measurement

Use one permitted brief and retain every attempt's stage, outcome, billable usage, and human correction time. Reconcile the run with provider statements. Repeat across accepted and failed journeys before projecting margins. The app's USD 200 advertising-pilot default is a proposed client test budget. It is not PitchProof revenue or a provider-cost estimate.
