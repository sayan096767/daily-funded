# Payout policy decisions and remaining inputs

The following high-level policy choices were supplied by the product owner on 2026-10-23. They are policy intent, not proof that the current data model can calculate or enforce eligibility.

## Canonical policy status

This file is the canonical checked-in record of payout-policy decisions for implementation. A checked-in catalogue, UI string, seed, or mutable production account value is evidence of configuration only; it is not proof of an approved payout policy or of the live value. Where the repository has no explicit approval or authoritative live rule source, payout eligibility must remain unavailable.

### Confirmed policy versus unverified candidates

| Item | Current evidence | Status and implementation rule |
|---|---|---|
| Net realized profit after applicable trading costs | Product-owner decision recorded below | Confirmed at a high level; the complete cost/adjustment source and calculation are unresolved. |
| Account-specific split applied once per payout period | Product-owner decision recorded below | Confirmed at a high level; the historical rule snapshot and period are not yet determinable. |
| Evaluation-stage profits are ineligible; only eligible profits earned while funded can be considered | Product-owner instruction in the current implementation task | Confirmed at a high level; the Worker does not yet establish funded lifecycle/account state well enough to calculate eligibility. |
| Open positions block payout eligibility | Product-owner decision recorded below; Worker checks open positions | Confirmed. |
| USD 10 reward after first approved purchase | Product-owner decision recorded below; `REFERRAL_REWARD_CENTS` and the approval writer implement 1000 cents | Confirmed for issuance. Refund, chargeback, reversal, and payout availability remain unresolved; do not treat credits as cash paid or payable. |
| Classic 1-Step 80%, 2-Step 90%, Instant 80% | `backend/app.py` catalogue and D1 `seed_forex.sql` / `migration_004.sql` | Candidate configuration values agree; not approval of the production payout split. Do not calculate payouts from these defaults alone. |
| Spark 1-Step 70%, Instant 70%, no Spark 2-Step | `backend/app.py` catalogue, D1 `seed_forex.sql` / `migration_009_spark_products.sql`, and Hosting FAQ | Candidate configuration/catalogue agrees; production availability and applicable payout rules are not verified. |
| $50 minimum eligible trading profit before split | The current task identifies this as a candidate; the Hosting withdrawal form separately has a $50 crypto request minimum, which is only a method UI setting | Unresolved as payout policy. If approved, clarify that pre-split does not resolve whether the threshold is on net eligible profit after costs or another basis; do not conflate it with the crypto method minimum. |
| No minimum trading days for payout | No payout-policy approval found; model/phase configuration contains minimum-day values | Unresolved and potentially inconsistent with evaluation rules. |
| Whether the split applies to all eligible profit or only the amount above the threshold | No decision found | Unresolved. |
| Payout-cycle boundary timestamps, timezone, inclusive/exclusive edge, first/partial cycle, late-arriving events, and stable cycle ID | No complete cycle contract found | Unresolved. |
| Loss offsets within and across cycles, negative carry-forward/reset, and late corrections | The high-level decision says losses follow account rules per period, but no applicable rule is selected or encoded | Unresolved. |
| Currency/minor-unit conversion and rounding, method fees, referral withdrawal semantics, and reversal/recovery | No complete policy contract found | Unresolved. Keep affected eligibility and payout operations blocked. |

## Approved high-level policy

- Eligible profit is net realized profit after applicable trading costs.
- Challenge/evaluation-stage profit is ineligible; only eligible profit from funded accounts may be considered.
- Calculate eligibility per payout period and apply the authoritative account-specific profit split once.
- Any open position blocks payout eligibility.
- Losses are treated per payout period, subject to the applicable account rules.
- A request must wait at least one hour before admin review. The wait never auto-approves or pays.
- Referral rewards retain the existing USD 10 rule and remain separate from trading profit and trading balance. They are not directly withdrawable; they may be a separate line item only in a combined payout after normal payout eligibility is established.
- Only an authorized admin may mark a payout paid, and only after verifying successful manual transfer.

Repository configuration and seed data are not proof of the live account policy. No payout calculation or settlement should be enabled until the remaining operational inputs below are supplied and the evidence sources are verified.

## Remaining decisions and required implementation inputs

- **Payout-period boundaries:** Define when a period starts/ends, how the first/partial period is handled, and what event closes or opens a period. D1 trades have `opened_at`/`closed_at`, but no payout-cycle records or boundary contract.
- **Applicable trading costs:** Identify the authoritative source and fields for commissions, swaps, fees, and adjustments, plus the allocation method. D1 `trades` stores realized price PnL but has no complete cost ledger.
- **Loss treatment within a period:** “Per payout period, subject to account rules” still needs the applicable rule for loss carry-forward/reset, corrections, and reversals. The current code does not implement these policy semantics.
- **Authoritative split and account-rule version:** Identify which immutable account-specific snapshot governs a payout and how phase changes or admin edits affect a period. The current snapshot can be updated and there is no verified historical version selection.
- **Remaining eligibility rules:** Supply/enforce the exact account states, drawdown breach consequences, minimum/profitable trading days, open-position data freshness, payout frequency, period minimum/maximum, and any payout-cycle restrictions. Some metadata exists, but there is no complete evaluator.
- **Currency and rounding:** Confirm payout currency, supported conversions, decimal precision, and rounding direction. D1 realized PnL is stored as `REAL`; no payout rounding policy is implemented.
- **Fees and combined request details:** Confirm payout-method fees, whether fees reduce trading payout or referral line items, and whether the UI’s current method minima and bank fee are authoritative.
- **Admin authorization and evidence:** Define the Firebase admin claim/role permitted to review versus finalize, whether duties must be separated, what transfer evidence/reference must be recorded, and how to adjudicate failure, reversal, duplicate reference, retry, and unknown outcome. Only successful manual transfer may reach `paid`; unknown outcomes must remain reserved/reconciliation-required.
- **Referral corrections:** The USD 10 first-approved-purchase reward is retained, but define chargeback/refund/reversal behavior and ensure the qualifying event remains the authoritative purchase approval.
- **Cross-store workflow contract:** Choose the authoritative payout store and reconciliation protocol. Firestore owns referral and user payout records while D1 owns trading records; a transaction across these systems is not atomic.

Until these inputs and trusted data/services exist, eligibility remains `unavailable`, payout creation remains blocked, and referral credits remain outside payout requests.

## Repository evidence for each unresolved decision

| Unresolved decision | Checked-in evidence and why it does not decide the policy |
|---|---|
| How to derive net realized profit after costs per period | The policy now says net realized profit per period. `calculatePnlUsd` and `settlePosition` in `DailyFundedTradingEngine/throbbing-bonus-6fed/src/index.flexible.js` store signed price-difference PnL in `trades.realized_pnl`; there is no payout period/base evaluator, complete cost ledger, or checked-in writer for Firestore `withdrawableProfit`. Period boundaries and cost source/allocation remain unspecified. |
| Losses, negative carry-forward, resets, corrections, refunds, reversals | Policy says losses follow account rules per period. `trades.realized_pnl` is signed (`schema.sql`, `trades`); no payout accounting evaluator or adjustment/refund/reversal ledger exists. The position settlement code only adds realized price PnL to simulated balance. The applicable account rule and carry-forward/reset behavior are not encoded. |
| Commissions, swaps, trading/platform costs and allocation | `calculatePnlUsd` takes position, close price, and symbol metadata; the D1 schema has no commission/swap/cost/adjustment ledger. The calculation cannot prove net payable profit or cost allocation. |
| Treatment of requested, reserved, rejected, failed, cancelled, and paid withdrawals | `backend/app.py:payout_request` returns 503 before request creation. `payout_request_history` only reads historical `users/{uid}/payoutRequests`; there is no reservation balance or transition writer. The schema has no payout ledger. |
| Authoritative rule snapshot across phases, edits, or corrections | `getAccountRuleContext` loads the current account snapshot. Worker model/snapshot admin routes can create/update rule values (`index.flexible.js` around model/snapshot handlers); schema snapshots have no verified immutable version history for payout calculations. The repository does not decide which historical rule applies. |
| Rounding and payout currency conversion | `calculatePnlUsd` converts supported instrument PnL to USD, but the payout path has no rounding or conversion policy. D1 PnL uses `REAL`; the blocked Flask request route has no server amount computation. |
| Allowed account states; drawdown breach consequences | Trading accounts have a status and snapshots store drawdown limits, but `/payout-eligibility` intentionally returns unavailable and does not evaluate breaches. No code defines payout consequences for a breach or recovery. |
| Minimum trading/profitable days | `minimum_trading_days` is stored/validated in rule snapshots and `daily_metrics` exists, but no payout evaluator counts qualifying days or defines profitable-day semantics. |
| Enforcing the open-position restriction and stale/missing market data | Policy now blocks eligibility while any position is open. Worker calculates floating PnL for trading views, but the payout evaluator does not check positions or market freshness/data gaps; the endpoint remains unavailable regardless. |
| Repeat-payout cycles, minimum/maximum, frequency, wait period | D1 model/snapshot fields include `minimum_payout`, `maximum_payout`, `payout_frequency`, and `payout_waiting_period_days`; they are configuration metadata only. UI `payoutMethodRules` in `FundingForge.html` has client-side minima/fees, not an authoritative backend policy. The 503 route creates no request and enforces no wait period. |
| Whether split values are 70/80/90 and exactly which phase's split applies | Seed SQL shows defaults only. Snapshot validation accepts any finite nonnegative value; the eligibility endpoint reports unsupported values as unavailable but does not calculate. Account/phase transition semantics for payouts are not established. |
| Reviewer/finalizer roles and separation of duties | Policy permits only an authorized admin to mark paid after verifying successful manual transfer. `require_admin` accepts Firebase `admin: true`; current admin endpoints concern purchase review. There is no payout-specific role model or decision on duty separation/evidence format. |
| Evidence for success/failure/cancellation/reversal, reference uniqueness, retries | No payout-provider adapter, webhook, manual-transfer completion route, or payout transition endpoint exists. `publicPayouts` is a read-only public feed, not proof connected to private requests. The successful-transfer requirement is known, but evidence, reference uniqueness, failure/reversal adjudication, retries, and unknown outcomes need operational definition. |
| Referral qualifying-event reversals and payout treatment | The policy retains the checked-in USD 10 rule and allows only a separate combined-request line item after normal eligibility. `award_referral_reward` creates one record on first approved purchase, keyed by referred UID. No chargeback/refund/reversal path is present; treatment of corrections remains unspecified. |

The current endpoint behavior is intentional: `GET /api/payouts/eligibility` returns `unavailable`; `POST /api/payouts/requests` returns 503 `payout_eligibility_unavailable` and performs no request, reservation, or referral-ledger write.
