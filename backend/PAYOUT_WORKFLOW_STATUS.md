# Payout workflow status

## Approved policy choices

The product owner approved the following high-level decisions on 2026-10-23:

- Profit is net realized profit after applicable trading costs, calculated per payout period.
- Apply the authoritative account-specific profit split to eligible profit for each period exactly once.
- Any open position blocks payout eligibility.
- Losses are treated per payout period according to account rules.
- Wait at least one hour before admin review; waiting never automatically approves or pays.
- Referral rewards remain the existing USD 10 reward, separate from trading profit and balance. They are not directly withdrawable and may appear as a separate line item only in a combined request after normal payout eligibility.
- Only an authorized admin may mark a payout paid after verifying successful manual transfer.

These approvals do not define missing accounting inputs, numerical thresholds, period boundaries, or transfer evidence. They do not authorize enabling a payout path while required values and sources remain unverified.

## Current accounting facts and limits

- D1 `trades.realized_pnl` records signed price-difference PnL from `calculatePnlUsd`/`settlePosition` in `DailyFundedTradingEngine/throbbing-bonus-6fed/src/index.flexible.js`. It is added to simulated account balance.
- The trade schema does not record a complete commission/swap/fee/adjustment ledger. D1 trade timestamps alone do not define payout period starts/ends or close/reset behavior.
- Firestore account provisioning initializes metrics, but no checked-in trusted writer for `withdrawableProfit` exists.
- D1 account-rule snapshots include `profit_split_percent`, payout metadata, drawdown configuration, and minimum trading days. The repository does not establish immutable rule-history selection for a payout period or a complete evaluator for those restrictions.
- The Worker read-only eligibility endpoint owner-scopes account and rules, checks for open positions, and always returns unavailable with null amounts. It does not calculate profit from trades or balance/equity.

## Current routes and safe behavior

- Authenticated Flask `GET /api/payouts/eligibility?accountId=...` proxies the owner-mapped account to Worker `GET /payout-eligibility?account_id=...`.
- Worker returns `payout-eligibility.v1` with `eligibility.status: unavailable`. Blockers include unverified profit, missing payout-period boundaries, missing costs/adjustments, unavailable withdrawal ledger, unresolved eligibility inputs, and `open_positions_present` when applicable. Amounts remain null.
- Authenticated `POST /api/payouts/requests` returns HTTP 503 `payout_eligibility_unavailable`; it creates no record, accepts no client amount as authoritative, and reserves no funds.
- Owner-scoped history remains read-only. Admin claim authorization exists for purchase review only. No payout review, rejection, manual-transfer confirmation/failure, or payout audit-transition route exists.
- Referral rewards are created as separate USD 10 Firestore ledger records on first approved purchase. They do not alter trading account values and are not included in payouts.
- The dashboard uses the eligibility API rather than Firestore `withdrawableProfit` for request availability. Referral funds are not included.
- Exact challenge splits, a $50 pre-split eligible-profit threshold, and “no minimum trading days” have not been confirmed as payout policy. The code catalogue and D1 seed values are configuration evidence, not proof of the applicable live rules. See `PAYOUT_POLICY_DECISIONS.md`.
- The Hosting dashboard labels referral rewards as credits and says they are not a payout. Legacy `credited` records are displayable history only and are not payout entitlements without reconciliation.

## Remaining blockers

See `PAYOUT_POLICY_DECISIONS.md` for exact choices/inputs and code evidence and `PAYOUT_REMAINING_WORK.md` for the implementation order. The critical blockers are the authoritative cost-adjusted payout-period ledger, period boundaries/loss semantics, applicable immutable account rules, remaining eligibility values, and an explicitly selected transactional payout store with reconciliation across Firestore and D1. Admin evidence and retry/unknown-outcome rules also need definition.

No payout creation, reservation, transfer, or completion is enabled until these items are resolved and tested.

## Changes and validation

- Worker eligibility adds a read-only, account-scoped query for open positions; it reports `open_positions_present` while the endpoint remains unavailable. No D1/Firestore financial writes are added.
- Worker regression covers positive realized PnL with an open position and asserts there is no amount/share and net-cost data is still a blocker. The unavailable reasons now distinguish unconfigured payout-period boundaries and unresolved eligibility inputs.
- Backend concurrent fail-closed regression runs eight simultaneous requests; all are rejected without creating payout/referral records.
- Backend: from `backend`, `..\.venv\Scripts\python.exe -m unittest test_referrals test_admin_auth` — 112 tests passed (2026-10-24 local run).
- Worker: from `DailyFundedTradingEngine\throbbing-bonus-6fed`, `.\node_modules\.bin\vitest.cmd run` — 171 tests passed (2026-10-24 local run).
- Previous reported checks include Worker source/test `node --check`, homepage inline JavaScript parsing, and Pylance syntax validation; the current task did not rerun those checks. `git diff --check` was rerun and passed.
- No full payout settlement E2E was run; those production workflow components do not exist. No production data access or deployment occurred.
