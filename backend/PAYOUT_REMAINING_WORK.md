# Payout remaining work

Payout creation and settlement are intentionally blocked. The high-level policy choices are recorded in `PAYOUT_POLICY_DECISIONS.md`; this document tracks the remaining authoritative inputs and implementation.

## Verified current behavior

- Flask `GET /api/payouts/eligibility` proxies the authenticated owner's account mapping to the Worker. Worker `GET /payout-eligibility` verifies the account and rule context, checks for open positions, and returns `payout-eligibility.v1` with `eligibility.status: unavailable` and null payout amounts.
- The unavailable response identifies the missing net-profit ledger, payout-period boundaries, trading cost/adjustment data, withdrawal ledger, and remaining eligibility inputs. If open positions exist it checks their account-scoped D1 records and reports `open_positions_present`.
- Flask `POST /api/payouts/requests` returns HTTP 503 `payout_eligibility_unavailable` before creating a request or reserving any funds.
- Dashboard eligibility comes from the server response; it does not use Firestore `withdrawableProfit` to enable requests. Referral credits remain separate and excluded.
- Referral creation currently uses a USD 10 reward for the first approved purchase, keyed by referred UID. This rule is retained; no payout settlement is implemented.
- Existing admin authorization validates Firebase `admin: true` for purchase-review routes, but no payout admin workflow exists.

## Blocking evidence and required work

1. **Net realized profit per payout period:** Policy is approved, but Worker `trades.realized_pnl` is price PnL and does not establish net profit after costs. There is no trusted writer for Firestore `withdrawableProfit`. Supply the authoritative cost/adjustment ledger and define its source and integrity.
2. **Payout period boundaries:** D1 trade timestamps exist, but no period identifier, period start/end, or period-finalization record exists. Define the period boundary and reset/carry-forward behavior; implement an authoritative period ledger.
3. **Losses under account rules:** Policy says loss treatment follows account rules per period. The applicable rule for losses, negative carry-forward, corrections, and reversals is not encoded in the current account snapshots/payout evaluator. Specify the exact rule and authoritative snapshot version.
4. **Account-specific split and rule history:** Snapshot metadata includes `profit_split_percent`, but snapshots can be updated and historical versions are not established. Define which immutable snapshot governs each period and ensure the live account split is trusted.
5. **Full remaining eligibility evaluator:** Open-position blocking is now checked read-only. Exact account states, drawdown breach effects, minimum/profitable trading days, stale data behavior, payout frequency, minimum/maximum, and cycle restrictions still need approved values and authoritative evaluators.
6. **Rounding, currency, fees:** Approve conversion/rounding, payout currency, authoritative minimums, and how payout fees are deducted. Existing UI minima/fees are client configuration, not server policy; the separate referral line item is already the approved presentation rule.
7. **Durable workflow store/reconciliation:** Decide the authoritative payout datastore. Firestore stores user/referral records; D1 stores trading records. They cannot be treated as one atomic transaction. Design/test an outbox or reconciliation protocol before any cross-store reservation or finalization is enabled.
8. **Admin/manual-transfer controls:** The high-level decision requires admin confirmation after successful transfer. Still specify evidence fields, reference uniqueness, retry/reversal handling, unknown-outcome state, actor/role separation, and audit retention. Implement only after durable payout records and an approved amount source exist.
9. **Referral reversals and inclusion:** Preserve the current USD 10 first-approved-purchase credit and separate line item. Define refund/chargeback corrections; implement reservation and release/finalization only atomically with the approved payout store and confirmed outcomes.
10. **Isolated end-to-end settlement tests:** Current tests verify fail-closed eligibility and no request/ledger writes. Full fake-transfer tests for reservations, admin review, timeouts, failures, success, retries, and reconciliation require the above production workflow components; none were simulated as if implemented.

## Current testability boundary

The concurrent request regression launches eight authenticated attempts and proves all receive 503 with no payout or referral writes. Worker tests prove positive realized PnL plus an open position still returns no payable amount and includes the open-position blocker. Latest recorded local results on 2026-10-24: 112 backend tests (`test_referrals test_admin_auth`) and 171 Worker tests pass. These are boundary tests only—not payout reservation or settlement tests. The backend counts do not include `r2_smoke_test.py`, which is not a unittest module and was not run because it is an external-storage smoke test.

No durable payout request schema, reservation ledger, payout-specific admin route, manual-transfer adapter, or reconciliation/outbox was added. Adding a disconnected mock workflow would not complete the real workflow; enabling any payout state transition without verified amounts and a chosen consistent store would be unsafe.
