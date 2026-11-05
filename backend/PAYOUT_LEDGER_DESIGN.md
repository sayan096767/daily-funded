# Payout ledger and reconciliation design proposal

**Status: DESIGN PROPOSAL — NOT IMPLEMENTED**

This document is a read-only architecture proposal. It does not authorize a
schema migration, payout creation, balance change, referral settlement, payment,
or deployment. The authenticated `POST /api/payouts/requests` endpoint must
continue to return `503 payout_eligibility_unavailable`; the read-only
eligibility endpoint must continue to report unavailable until the blockers
below are resolved.

## Executive summary

The repository has two distinct financial domains and no verified, complete
payout ledger:

- The Cloudflare Worker and D1 own the simulated trading account, positions,
  closed-trade price PnL, daily metrics, and the current account-rule snapshot.
- Flask and Firestore own user/account metadata and the existing referral
  reward records. Firestore `withdrawableProfit` is exposed as account metadata
  in one backend response, but no trusted writer or derivation from D1 was
  found.
- Flask verifies Firebase ID tokens and uses a service token to call the
  Worker. The Worker also checks that the requested D1 trading account belongs
  to the authenticated UID forwarded by Flask.
- The repository has no payout reservation/settlement schema, no complete
  trading-cost ledger, no payout-period contract, and no verified manual
  transfer confirmation workflow.

**Recommended direction, subject to review:** make D1 the canonical store for
trading payout periods, trading reservations, payout state, and their immutable
audit events, since D1 already owns the account/trade/rule data required for
trading eligibility. Keep referral rewards as a separate payout type and
preserve Firestore as the current reward source until an explicit migration or
ledger-ownership decision is approved. Bridge referral events into the chosen
payout store through a durable, idempotent outbox/reconciliation process; do
not claim atomicity across D1 and Firestore. No balance should become
withdrawable merely because it was copied from Firestore or calculated from
the current `trades` table.

This recommendation is not an assertion that D1's current data is sufficient
to calculate a payout. The business and data blockers in this document must be
resolved first.

## 1. Source of truth: verified facts and proposed ownership

| Domain | Verified repository fact | Proposed source of truth / limitation |
|---|---|---|
| User identity | Flask verifies Firebase ID tokens. Its Worker proxy supplies the verified UID to the Worker. | Firebase UID is the user identity. Never accept an owner UID from the browser as proof of ownership. |
| Trading account identity and owner | D1 `trading_accounts` has the account ID and `user_id`; Worker ownership lookup matches both. Firestore account metadata also maps the owner to `tradingEngineAccountId`. | D1 `trading_accounts.id` plus `user_id` is authoritative for a Worker trading account. Firestore is a mapping/metadata source, not a substitute for D1 ownership verification. |
| Positions and closed trades | Worker/D1 store `positions`, `trades`, and `daily_metrics`. `settlePosition()` records `trades.realized_pnl` and updates simulated account metrics. | D1 is authoritative for the trading simulation records as currently implemented. This does not establish that `realized_pnl` is net payout profit. |
| Trading costs and adjustments | No complete commissions, swaps, fees, corrections, or reversal ledger was verified in the reviewed D1 schema. | No authoritative source is established. Payout calculation must remain unavailable until the complete cost/adjustment source and semantics are defined and recorded. |
| Current account rules | D1 has account-rule snapshots and challenge-model/phase rules. `getAccountRuleContext()` uses account rule context. The current snapshot is mutable; immutable payout-period rule-version selection was not verified. | D1 is the candidate source for rule data, but each payout period needs an immutable, auditable rule snapshot and an approved rule-selection policy. |
| Profit split | D1 account-rule snapshots contain `profit_split_percent`; seed/configuration data includes 70%, 80%, and 90%. No verified payout calculation applies it. | Read the account-specific, approved snapshot on the server and freeze its value/version into the payout-period calculation. Reject unsupported/missing values. The applicable phase and effective-time policy remain unresolved. |
| Referral reward | Flask's `award_referral_reward()` creates a USD 10 `available` Firestore reward associated with the first approved purchase, using a Firestore transaction. No referral reservation/settlement was found. | Firestore is the current source for reward issuance. A future separate referral payout must only use source rewards confirmed and idempotently mirrored/claimed in the canonical payout ledger. Refund/chargeback reversal behavior is not implemented or decided. |
| Payout available balance | Flask exposes Firestore `withdrawableProfit` through `list_accounts()`, but no checked-in trusted writer deriving it from D1 was found. | No trusted payout balance currently exists. Do not import or spend existing values until individually reconciled to authoritative source events. |
| Payout request/history | `payout_request()` is deliberately fail-closed and does not write a request. `payout_request_history()` reads owner-scoped historical Firestore subcollection documents if present. | A new durable ledger must be selected and introduced before real requests. Existing history is not proof of a reserved or paid balance. |
| Payment settlement | No verified manual-transfer adapter or authorized payout completion/failure route was found. | An authorized human records verified transfer evidence; a server-side state transition and immutable ledger event record the confirmation. No automated transfer is proposed. |

### Ownership and trust boundary

The backend must resolve an account from the authenticated Firebase UID, then
the Worker must independently verify `(account_id, user_id)` against D1. For a
trading request, no client account owner, account status, balance, PnL, rule,
profit split, eligibility result, referral amount, or payout total is
authoritative.

The current Worker service-token plus `X-Authenticated-User-Uid` pattern is
appropriate only when the Worker endpoint is reachable through the trusted
backend path and the service token is unavailable to clients. A future
privileged admin route must not accept an arbitrary actor UID from request
headers. Flask must verify the Firebase admin credential, attach a verified
actor identity to an authenticated service request, and the Worker must
authorize the privileged operation and persist the actor/action audit record.
The existing `require_admin()` checks the Firebase boolean custom claim
`admin: true` for current purchase-admin operations; payout-specific roles,
review/finalizer separation, and the sufficiency of that broad claim are not
approved by the repository.

## 2. Ledger records and immutability

The following is a proposed logical schema, not an existing schema or migration.
Use integer minor currency units (for USD, cents) after an approved conversion
and rounding policy; do not use binary floating-point values as ledger amounts.
Every stored amount has an explicit currency. Never update or delete a
committed financial event to "correct" history: append a compensating
adjustment/reversal linked to the source event.

### Proposed core records

1. **`payout_periods`**
   - Unique period ID, account ID, owner UID, currency, start/end boundary,
     status, created/closed timestamps, and calculation version.
   - Frozen account phase, rule snapshot ID/version, `profit_split_percent`,
     and a hash or exact references to all included source events.
   - A period cannot be closed/calculated until the approved boundary and
     completeness rules are met.
2. **`payout_ledger_entries`** (append-only)
   - Unique entry ID, account ID, owner UID, optional period ID, currency,
     signed integer amount, entry type, source system/source record ID,
     effective and recorded timestamps, idempotency key, and optional
     `reversal_of`/correction reference.
   - Unique source-event/idempotency constraints prevent one trade, cost,
     referral reward, or adjustment from being ingested twice.
   - Trading PnL/cost entries and referral-reward entries are different
     ledger domains/types and are never combined in a profit calculation.
3. **`payout_requests`**
   - Unique request ID, owner UID, payout type (`trading` or `referral`),
     currency, amount, state, idempotency key, created timestamp,
     `review_after`, destination reference, and immutable snapshots/references
     to the period or selected reward IDs.
   - Store private destination details in an access-controlled record or
     secret reference; never return them from public list/eligibility endpoints.
4. **`payout_reservations`**
   - Request ID, ledger source/period or reward ID, reserved amount, status,
     creation/release/consume timestamps, and idempotency key.
   - Unique constraints prohibit reserving the same available source amount
     or referral reward twice. Reservation and request creation must commit
     atomically in the canonical payout store.
5. **`payout_audit_events`**
   - Append-only event ID, request ID, actor identity and authorization
     context, old/new state, action/reason, timestamp, idempotency key,
     and evidence reference/hash. Do not store payment secrets in general
     audit text.
6. **`payout_outbox` / source inbox**
   - Durable source event ID, source store, event type, payload version,
     delivery status, attempt count, timestamps, and last error.
   - Consumers use a unique event ID and idempotent insert/transition.
     Keep payloads minimal and avoid copying private payment destinations.

The deployed D1 binding supports SQLite-style constraints and batch operations,
but the exact atomic reservation implementation must be validated against the
Cloudflare D1 transaction/batch semantics and the actual database binding
before implementation. The design requires one atomic unit for request,
reservation, and initial audit event; if the chosen store cannot guarantee that,
use a durable idempotent workflow with explicit intermediate states and
reconciliation rather than claiming atomicity.

## 3. Net-profit calculation and unresolved accounting rules

The approved high-level policy is **net realized profit after applicable
trading costs**, calculated per payout period, with the authoritative account
profit split applied once. The current Worker does not prove the inputs needed
for that calculation:

- `calculatePnlUsd()` calculates price-difference PnL using position/close
  details and symbol metadata.
- `settlePosition()` records signed price PnL in `trades.realized_pnl` and
  updates simulated account balance/equity.
- The reviewed schema does not provide a complete ledger for commissions,
  swaps, platform fees, cost adjustments, refunds, or corrections.
- The current D1 trade records therefore cannot be described as net payout
  profit. Account balance/equity and Firestore `withdrawableProfit` are not
  substitutes for an audited period ledger.

### Proposed calculation once its inputs and rules are approved

For a closed period, derive a net period result only from immutable,
account-owned source entries with defined effective times:

`net_period_profit = realized_trade_pnl + approved_adjustments - allocated_trading_costs`

The trader share is then calculated once from the approved, frozen account
split and the policy-defined eligible amount:

`trader_share = policy_eligible_period_profit * frozen_profit_split_percent`

Both expressions are specifications, not executable formulas yet. No sign
handling, cost allocation, rounding, or carry-forward is implied by them.
Before calculating, verify the period is complete, no position is open (the
approved restriction), source records are not duplicated, rule/split snapshot
is valid, and every required account eligibility condition has a trusted
source and evaluator. Missing inputs produce an explicit `unavailable`
eligibility result and no request, reservation, balance write, or Firestore
`withdrawableProfit` update.

### Decisions still required

- **Period boundaries:** start/end event, timezone, first/partial period,
  when a period closes, and how late trades/costs are assigned.
- **Loss treatment:** whether a negative period carries forward, resets,
  offsets only within a period, or affects future periods; how a correction
  reopens or adjusts a closed period.
- **Cost source and allocation:** authoritative commission/swap/fee fields,
  whether costs can be non-trade-specific, and their allocation to a period.
- **Adjustments and reversals:** treatment of trade corrections, refunds,
  chargebacks, administrative adjustments, and out-of-order events.
- **Rule snapshot selection:** applicable account phase, split effective time,
  handling of an account phase change during a period, and immutable version
  source. Although configured examples are 70%, 80%, and 90%, the live
  authoritative snapshot and allowed-value enforcement must be verified.
- **Eligibility rules:** exact allowed account states; drawdown breach and
  recovery consequences; minimum and profitable trading day definitions;
  payout frequency, per-period limits, and other challenge restrictions.
- **Data freshness/completeness:** how missing, delayed, or corrected Worker
  events and stale positions are detected before a period is finalized.
- **Currency and rounding:** payout currency, conversions, precision,
  rounding mode/order, and when rounding occurs.
- **Repeat withdrawals:** whether one or multiple requests may draw on a
  period, and whether any post-request trade or adjustment changes eligibility.
- **Existing payout records:** how to verify historical requested/paid amounts
  and what external evidence establishes that a historical manual transfer
  really succeeded.

No split, net-profit, loss, or eligibility rule should be inferred from seed
values, UI values, or current account metrics.

## 4. Payout periods and duplicate-profit prevention

Create a period only under an approved boundary contract. Assign each realized
trade/cost/adjustment source event to exactly one account and period; use a
unique `(source_system, source_record_id, entry_type)` or equivalent key.
Persist the period's source-set/version and calculation version so an
independent reviewer can reproduce the result.

When a period is closed, calculate its result from the ledger once and create
one or more requestable claims only under the approved repeat-withdrawal and
loss rules. A request must reserve a specific remaining claim/ledger amount,
not recompute an amount from a client field. The total of all active
reservations plus consumed claims must never exceed the approved amount for
that period. A unique request idempotency key handles a client retry; a
separate uniqueness constraint on the period/claim prevents a second key from
creating an overlapping claim.

Period recalculation after closure must not overwrite a prior result. Record a
new version and compensating entries, then follow an approved policy for
unreserved and already-reserved funds. If an adjustment affects a request
already in transfer or an uncertain state, preserve the reservation and route
to reconciliation; do not silently debit or release it.

## 5. Rule and split snapshots

At period opening (or at the policy-approved effective event), capture the
account ID, owner UID, account phase, source rule snapshot ID/version,
`profit_split_percent`, and the effective timestamp. At calculation and
request creation, verify this frozen snapshot against the authoritative D1
source and validate the allowed split values. Store the snapshot used on the
period/request; never consult a later mutable value to reinterpret a historical
request.

Existing `account_rule_snapshots` are per-account current snapshots and are
mutable in the reviewed schema. They do not by themselves prove which value
governs a historical period. A new immutable version/event table or equivalent
append-only snapshot mechanism, plus policy for phase changes, is required.
Persist the actual split value, phase, source snapshot/version identifier, and
effective timestamp into an immutable period record; storing only a pointer to
a mutable row would not prevent historical split drift.

## 6. Atomic reservations and concurrency

The canonical payout ledger must serialize each request's balance check and
reservation. In a single atomic database operation:

1. Validate authenticated owner, current request idempotency key, period or
   reward selection, eligibility snapshot, and available unreserved amount.
2. Insert the payout request in `requested`/`waiting`.
3. Insert exact source reservations and the initial audit event.
4. Commit all three or none.

Use unique constraints for request idempotency and source reservation identity.
Handle a uniqueness conflict as an idempotent replay only if the stored request
belongs to the same owner and its normalized payload matches. Different
payloads for an existing key must return a conflict. Use conditional updates
or serialized D1 transactions/batches; do not read an available amount and
later write a reservation in separate unprotected calls.

For partial claims, a unique reservation key alone is insufficient: two
different requests could each reserve part of the same claim and together
exceed its value. Keep a canonical claim row with integer `approved`,
`reserved`, and `consumed` minor-unit counters and perform a guarded
compare-and-set in the same transaction as request/reservation/audit inserts:
only update when `approved - reserved - consumed >= requested`. Alternatively,
make claims indivisible and enforce one reservation per claim. The chosen
database must enforce the condition atomically, and tests must prove rollback
when the guard fails. Validate D1's exact transaction/batch behavior before
selecting it; do not treat a batch of statements as proof of an aggregate
invariant unless the conditional write and all inserts are atomic together.

For concurrent requests, only one can reserve any given claim/reward. Retry
transient database errors with the same idempotency key. If commit outcome is
unknown, query the durable request by idempotency key before retrying. Never
release because a client timed out.

## 7. Separate referral rewards and referral payout requests

The latest approved policy is explicit: **referral bonuses use a separate
referral payout request; never mix referral rewards into trading profit or a
trading request.** Preserve the existing USD 10 reward rule only for a
qualifying first approved purchase, subject to the existing `award_referral_reward()`
logic and future approved refund/chargeback rules.

There is a conflicting older statement in `backend/PAYOUT_POLICY_DECISIONS.md`
and `backend/PAYOUT_WORKFLOW_STATUS.md` that permits a referral line item in a
combined request. The latest explicit product-owner instruction supersedes
that wording for this design: a referral request must be separate. Do not
implement either behavior until the policy/status documents are reconciled;
this proposal does not edit those documents.

Treat the Firestore reward document (currently keyed by referred UID) as the
current reward-issuance record. Do not mark it paid or make it withdrawable
from the dashboard. A referral request selects server-verified available
reward IDs and reserves each reward exactly once. Use reward ID as an
idempotency/source key. Reject client-supplied reward amounts, referrer IDs,
or ownership.

For cross-store consistency, the Firestore transaction that creates a reward
should also create a durable outbox event in the same Firestore transaction.
A consumer copies that event into the payout ledger's inbox/ledger using its
stable event ID; the unique ID makes redelivery safe. If Firestore cannot
atomically create the reward and outbox in the current call path, first change
that source flow and add a reconciliation scan that detects rewards missing
from the inbox. The consumer must acknowledge source delivery only after the
ledger commit. Do not represent a Firestore-to-D1 operation as a distributed
transaction.

On an approved reversal/chargeback source event, append a compensating reward
entry and prevent a new reservation. If already reserved, under review, or in
transfer, retain the reservation and send it to reconciliation; do not
silently claw back or cancel a manual transfer. The qualifying purchase's
refund/chargeback source and policy are not currently established.

## 8. Lifecycle and reservation effects

Proposed states (not implemented):

| State | Meaning | Reservation effect |
|---|---|---|
| `requested` | Durable request accepted; initial persistence/audit completed. | Held. |
| `waiting` | One-hour minimum review delay has not elapsed. | Held. |
| `under_review` | Delay elapsed and an authorized reviewer has opened review. | Held. |
| `approved` | Authorized reviewer approved the request for manual transfer. | Held. |
| `transfer_pending` | Admin has recorded that manual transfer is being attempted or is awaiting verification. | Held. |
| `paid` | Authorized admin verified successful transfer and recorded required evidence. Terminal. | Consumed exactly once. |
| `rejected` | Authorized reviewer rejected before transfer; reason recorded. Terminal unless a new request is allowed. | Released exactly once. |
| `failed` | Failure is positively confirmed and policy permits retry/new request. | Released only after confirmed no-payment outcome and audited transition. |
| `cancelled` | Authorized cancellation is confirmed safe before payment is attempted. | Released exactly once. |
| `reconciliation_required` | Transfer outcome, commit, evidence, or cross-store sync is uncertain. | Held; no retry/payment/release until reconciled. |

The one-hour rule is checked server-side against the durable `requested_at`
timestamp before entering `under_review` or `approved`; it is not a scheduled
auto-approval. State changes use compare-and-set/conditional transitions,
require an actor or trusted system reason, and append one unique audit event.
Illegal transitions fail closed.

The transfer outcome distinction is essential:

- **Confirmed success:** an authorized admin verifies transfer completion,
  records evidence/reference and confirmation time, and commits `paid` plus
  reservation consumption in one ledger transaction.
- **Confirmed no-payment failure:** an authorized admin records evidence that
  no transfer occurred (or the transfer was reversed under approved policy);
  the request becomes `failed` and its reservation releases once.
- **Timeout/unknown outcome:** `reconciliation_required`, reservation held,
  no automatic retry, no `paid` state, and no release. An authorized reviewer
  resolves it using independent transfer evidence.
- **Rejection before transfer:** release once and retain the rejection reason.
  Rejection after a transfer attempt is not a safe release; use reconciliation.

The current repository has no transfer adapter. Any future fake adapter is for
isolated tests only. It must not submit real transfers or return a fabricated
success in application code.

## 9. Admin authorization and payment evidence

Current `require_admin()` in Flask checks Firebase custom claim `admin: true`
for purchase-admin endpoints. This is verified existing authorization, but
the repository has no payout-specific role separation, reviewer/finalizer
policy, or transfer evidence requirements.

Before implementation, approve:

- Which role may view sensitive destination details, review, reject, approve,
  initiate/record manual transfer, confirm success, and resolve uncertain
  outcomes.
- Whether the request creator/reviewer and payment confirmer must be different
  people.
- Evidence fields and retention (for example a restricted transfer reference,
  date, destination match, and evidence object reference/hash); never accept
  an unverified client assertion as proof.
- Duplicate transfer reference handling, reversal handling, and who can
  override a conflict.

At minimum, every admin action must re-authenticate/verify the actor's current
authorization, record actor UID/role and action in the audit log, enforce the
state transition, and prevent duplicate confirmation with a unique
confirmation/idempotency key. General admin access alone should not silently
grant access to payout destinations.

## 10. Cross-store consistency and recovery

Firestore and D1 do not share an atomic transaction. Recommended ownership:

- D1: trading-account payout periods, net trading ledger, trading reservations,
  trading payout requests, and their state/audit events.
- Firestore: existing referral issuance and purchase provenance until an
  approved migration. Add Firestore outbox records atomically alongside reward
  issuance, then idempotently deliver/refelect those rewards in the payout
  ledger. A referral payout request/reservation should use one canonical store
  for its durable claim state; do not split the reservation across databases.
- Flask: API/authentication boundary and admin authorization; not the balance
  authority.

The precise canonical store for referral reservations and all payout request
history remains a design decision. Prefer one canonical store for requests,
reservations, transitions, and audit events. If D1 is selected, Firestore is
the upstream referral source and its outbox/inbox bridge is mandatory. If
Firestore is selected instead, trading ledger access would require a similarly
durable D1 outbox and would still need a safe cross-store reservation protocol.
Do not implement a design that requires an atomic D1+Firestore commit.

An outbox provides durable eventual delivery, not cross-store atomic
consistency: after a partial failure, Firestore and the payout store may
temporarily disagree. Until a reward event is durably ingested and reconciled,
its amount must be unavailable to referral payout requests. Reconciliation
must expose undelivered events and mismatches, retain reservations on
uncertainty, and never auto-settle or infer payment. This does not guarantee
that every inconsistency is automatically repaired; unresolved cases require
an operator decision and an auditable resolution.

Recovery/reconciliation should be an authenticated, idempotent scheduled
consumer or operator-triggered job, with bounded retries and durable error
records. The Worker currently has a five-minute scheduled handler that
activates the market feed; no payout reconciliation job was verified. Add
payout reconciliation only after an ownership decision. It should:

1. Reprocess undelivered outbox events idempotently.
2. Compare source rewards/trades with ingested source IDs and surface gaps.
3. Find requests stuck in nonterminal states, but never auto-approve, mark
   paid, release an uncertain reservation, or retry an uncertain transfer.
4. Reconcile Firestore legacy history and D1 request/audit state, recording
   discrepancies for human action.
5. Alert/emit durable reports for mismatched totals, duplicate source IDs,
   stale events, missing evidence, or impossible state transitions.

## 11. Auditability and privacy

For each eligibility result, retain the result version, requested account,
verified owner, timestamp, blocker codes, source event/version references,
rule snapshot, open-position check, and relevant data-freshness markers. Do
not log private payment destinations or tokens.

For each ledger event, retain immutable source identity, amount/currency,
effective/recorded time, idempotency key, event type, and reversal/correction
link. For each request, preserve normalized request intent, source reservations,
eligibility calculation reference, rule/split snapshot, all state changes,
admin actor identities, reasons, and confirmation evidence references.

Owner history endpoints return only the caller's requests and non-sensitive
status/amount metadata. Admin endpoints require explicit authorization and
should reveal destinations only to roles that need them. Existing
`payout_request_history()` already filters to the authenticated user's
Firestore subcollection and omits destination data; preserve that privacy
behavior during migration.

## 12. Existing-record migration and recovery

Do not silently import Firestore `withdrawableProfit` or existing payout
history as a ledger opening balance. These fields are not backed by a verified
trusted writer, net-profit derivation, reservation record, or confirmed payment
evidence.

Before any migration:

1. Inventory historical `withdrawableProfit`, payout request documents,
   referral reward documents, purchase approvals/refunds, D1 trades/positions,
   rule snapshots, and any external/manual transfer evidence using approved
   non-production test data first.
2. Map each proposed opening entry to immutable source evidence and determine
   if it is already reserved, rejected, paid, or uncertain.
3. Reconcile every historical payment against independent transfer evidence;
   quarantine unknown outcomes as `reconciliation_required`.
4. Keep unmatched amounts unavailable; require authorized case-by-case
   resolution and an audit event. Never infer "paid" from a status label alone.
5. Dry-run and review migration totals, duplicate IDs, ownership mismatches,
   and period/source gaps before a separately approved production migration.

No production-data read or write was performed for this proposal.

## 13. Verification matrix: current code vs required work

Paths below are repository-relative. Function/route names identify the
implementation points inspected; proposed work is not present yet.

| Component | Existing implementation / evidence | Missing work, schema, tests, and recovery |
|---|---|---|
| Trading account ownership | Worker `findAccountForUser()` matches D1 account ID and user ID; Flask maps Firestore account metadata to `tradingEngineAccountId` and proxies the authenticated UID. | Use this path for every account operation; test missing mapping, mismatched owner, and forged client UID. Never permit an admin proxy to impersonate from caller input. |
| Position opening/closing | Worker position/order routes write D1 `positions`; `settlePosition()` and `calculatePnlUsd()` close a position and record price PnL. Worker tests cover trading behavior. | No payout source completeness contract, costs ledger, period assignment, correction/reversal flow, or payout replay protection. Add schema only after net-profit definitions and source completeness are approved. |
| Account rules/split | `getAccountRuleContext()` reads the current account-rule context. `migration_002.sql` defines challenge/phase and account rule snapshot data, including split and eligibility metadata. | Current snapshot can change; no immutable payout-effective history or policy for phase changes. Add versioned rule history and tests for 70/80/90, invalid values, missing snapshot, effective-time selection. |
| Eligibility | Flask `GET /api/payouts/eligibility` proxies to Worker. Worker `/payout-eligibility` reports unavailable and checks open positions. | Keep unavailable until all costs, periods, state/drawdown/day rules, split version, freshness, and currency rules are implemented. Test each unavailable reason and prove no writes occur. |
| Request creation | Flask `POST /api/payouts/requests` returns 503 `payout_eligibility_unavailable`; no request or reservation is written. | Retain this response. Future D1 schema needs request, reservation, idempotency, unique source claim, and audit-event records committed atomically. Test same-key retries, changed-payload conflicts, concurrent reservations, and unknown commit recovery. |
| Request history | Flask `payout_request_history()` reads owner-scoped Firestore `users/{uid}/payoutRequests`, omitting private destinations. | No durable settlement state machine is verified. Decide canonical request store, migrate only reconciled records, and test owner isolation and destination privacy. |
| Referral issuance | Flask `award_referral_reward()` writes USD 10 `available` reward on first approved purchase in a Firestore transaction; referral dashboard reads rewards. | No reservation/reversal/settlement, outbox bridge, or chargeback handling. Add Firestore transactional outbox with issuance, idempotent consumer/inbox, unique reward reservation and separate referral request, then test redelivery and reversal recovery. |
| Admin authorization | Flask `require_admin()` checks Firebase custom claim `admin: true`; current admin routes concern purchase review. | No payout roles, action-specific checks, transfer evidence, duty-separation policy, or audited state transitions. Approve the role matrix before adding endpoints; test each route with owner, non-admin, admin, and stale/missing credentials. |
| Transfer completion | No manual transfer adapter or payout paid/failed route was verified. | Add admin-only state transition and evidence record only after policy approval. Unknown outcome retains reservation. Test timeout, confirmed failure, success, duplicate confirmation, retries, and reconciliation without real payment. |
| Scheduled recovery | `wrangler.jsonc` configures a five-minute cron; Worker `scheduled()` currently ensures the market feed is active. | No payout reconciliation exists. Add a bounded, idempotent reconciliation consumer only after store/outbox contracts are chosen; test partial failures and repeated runs. |
| Firestore client access | `firestore.rules` allows users to read their own documents/subcollections and denies client financial writes; backend uses Admin SDK. | Preserve server-only writes; test rules and authenticated API privacy. Do not expose payout destinations through account/dashboard responses. |
| Dashboard | `hosting-public/FundingForge.html` uses eligibility API to reflect availability; it does not use Firestore `withdrawableProfit` to enable a request. | Keep unavailable and show genuine server states only. UI must not infer eligibility or create client-calculated totals. |

### Relevant existing files inspected

- `backend/app.py`
- `backend/PAYOUT_POLICY_DECISIONS.md`
- `backend/PAYOUT_REMAINING_WORK.md`
- `backend/PAYOUT_WORKFLOW_STATUS.md`
- `backend/REFERRAL_PAYOUT_STATUS.md`
- `backend/test_referrals.py`
- `backend/test_admin_auth.py`
- `firestore.rules`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/src/index.flexible.js`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/test/index.spec.js`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/schema.sql`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/migration_002.sql`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/migration_003.sql`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/migration_005.sql`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/migration_008_server_position_protection.sql`
- `DailyFundedTradingEngine/throbbing-bonus-6fed/wrangler.jsonc`
- `firebase.json`

## 14. Safeguard audit: design intent versus verified implementation

The controls below describe the current checked-in implementation, not what a
future schema or route is intended to do. **NOT IMPLEMENTED** means no running
code, schema constraint, or test demonstrates the safeguard. A passing
fail-closed test is not evidence that a future reservation or settlement
workflow is race-safe.

| # | Safeguard | Status | Evidence and limit |
|---|---|---|---|
| 1 | Two simultaneous requests cannot reserve the same profit. | **NOT IMPLEMENTED** | `backend/app.py:payout_request()` returns 503 before writes. `backend/test_referrals.py:test_concurrent_payout_attempts_remain_blocked_without_creating_records` launches eight attempts but only proves they are all blocked and create no records; it does not exercise reservations. No payout claim/reservation table or uniqueness/conditional-update constraint exists in `schema.sql` or the reviewed migrations. |
| 2 | Retries cannot duplicate ledger entries. | **NOT IMPLEMENTED** | There is no payout ledger, outbox, inbox, or payout idempotency constraint in the reviewed D1 schema/migrations. `payout_request()` does not create a record. The proposed unique source/idempotency keys are design requirements only. |
| 3 | Rejection/cancellation cannot release funds twice. | **NOT IMPLEMENTED** | No payout rejection/cancellation transition or release operation exists in `backend/app.py`; there is no reservation status/transition constraint or corresponding test. “Release exactly once” is not a code guarantee until implemented with a conditional state transition and unique release event. |
| 4 | A successful manual transfer cannot be marked paid/consumed twice. | **NOT IMPLEMENTED** | No payout transfer-confirmation route, payment evidence record, paid transition, or reservation-consumption schema/test exists. `require_admin()` in `backend/app.py` is used for existing admin operations, not payout settlement. |
| 5 | An uncertain transfer cannot be retried as if it failed. | **NOT IMPLEMENTED** | No manual transfer workflow or `reconciliation_required` state exists. The proposal requires a held reservation and no retry while outcome is unknown, but no runtime transition or test enforces it. |
| 6 | Referral rewards are not counted as trading profit. | **VERIFIED FOR CURRENT PATHS; FUTURE LEDGER GUARANTEE NOT IMPLEMENTED** | `backend/app.py:award_referral_reward()` writes a separate Firestore `referralRewards` document, and `backend/test_referrals.py:test_reward_is_one_time_and_separate_from_trading_balance` checks its USD 10 record contains no trading-balance field. The blocked `payout_request()` does not read rewards or accept client referral amounts as authority (also covered by `test_client_supplied_referral_values_cannot_bypass_payout_block`). No future payout ledger/calculation exists to prove the invariant end-to-end. |
| 7 | Historical profit splits cannot change after account configuration changes. | **NOT IMPLEMENTED** | `migration_002.sql` defines `account_rule_snapshots` with `UNIQUE(account_id)` and mutable fields including `profit_split_percent`; Worker `getAccountRuleContext()` reads the current snapshot, and update routes modify rule values. No immutable payout-period split copy/version or historical rule-selection test exists. |
| 8 | Firestore/D1 partial failures cannot leave inconsistent state. | **NOT IMPLEMENTED** | No payout outbox/inbox or reconciliation consumer exists. `award_referral_reward()` currently creates a Firestore reward in a Firestore transaction without an outbox. Firestore and D1 have no shared transaction in this code. The proposed outbox would provide eventual delivery and detection, not eliminate temporary divergence; un-ingested rewards must remain unavailable. |
| 9 | Unreconciled legacy `withdrawableProfit` is not treated as verified money. | **CURRENT REQUEST PATH VERIFIED BLOCKED; RECONCILIATION NOT IMPLEMENTED** | `backend/app.py:payout_request()` returns 503 without reading `withdrawableProfit`; `backend/test_referrals.py:test_payout_request_fails_closed_without_verified_eligibility_source` checks no request write, and the concurrent test checks no records. However, `backend/app.py:list_accounts()` still returns the Firestore field, and no historical reconciliation/import-quarantine process exists. The value must not be used as an opening ledger balance without independent reconciliation. |

### Policy-source discrepancy to resolve

`PAYOUT_POLICY_DECISIONS.md`, `PAYOUT_WORKFLOW_STATUS.md`, and
`REFERRAL_PAYOUT_STATUS.md` still say referral rewards may be combined with a
normal payout. That conflicts with the latest approved instruction for this
task, which requires a **separate referral payout request**. This design
records the latest instruction, but the older documents should be reconciled
before implementation so policy is not inferred from contradictory repository
text. This review changes only this design document.

The other high-level decisions recorded in those documents remain: net
realized profit after applicable costs, per-period split, open positions block
eligibility, one-hour minimum before admin review, and manual success
confirmation by an authorized admin. They do not settle the detailed policy
inputs listed below.

## 15. Prioritized implementation checklist (gated; not authorization)

Do not begin financial runtime implementation or enable requests until the
blocking gates are approved and evidenced. The order below avoids building a
reservation or UI workflow around an undefined amount source.

### P0 — Resolve product policy and correct conflicting documents

- Reconcile `PAYOUT_POLICY_DECISIONS.md`, `PAYOUT_WORKFLOW_STATUS.md`, and
  `REFERRAL_PAYOUT_STATUS.md` to the separate-referral-request rule.
- Decide payout-period boundaries and partial-period behavior.
- Decide loss carry-forward/reset, corrections, reversals, and late events.
- Decide cost types/source/allocation; account states, drawdown treatment,
  minimum/profitable days, payout frequency/limits, fees, currency, conversion,
  and rounding.
- Decide applicable phase/split effective time, repeat withdrawals, and
  handling of post-request corrections.
- Decide referral refund/chargeback reversals, separate referral request
  eligibility/minimums/fees, and evidence of the qualifying purchase.
- Decide payout-specific roles, separation of duties, transfer evidence,
  duplicate references, failure/reversal treatment, and uncertain-outcome
  adjudication.

**Gate:** product policy has one unambiguous written source; no business rule
is inferred from seed values or UI configuration.

### P1 — Verify authoritative sources and produce a reproducible amount

- Identify and validate complete immutable realized-trade, commission, swap,
  fee, adjustment, correction, and reversal events.
- Establish period assignment and completeness/freshness proofs.
- Add immutable versioned account-phase/rule snapshots, including the exact
  split value effective for each period.
- Implement a server-only, versioned eligibility/calculation service that
  fails unavailable on any missing source, invalid owner/rule, open position,
  or unresolved rule.
- Prove the calculation against isolated fixtures and independently recompute
  expected results; do not read `withdrawableProfit` as input.

**Gate:** accounting owner signs off on sample reconciliation and all required
eligibility rules have authoritative values and tests.

### P2 — Choose the canonical payout store and enforce ledger invariants

- Select one canonical store for requests, reservations, transitions, and
  audit events; verify its atomicity/conditional-write guarantees.
- Add append-only ledger, period/claim, request, reservation, idempotency,
  audit, and outbox/inbox schema with integer minor units and source uniqueness.
- Use guarded atomic claim-counter updates so active reservations plus
  consumption cannot exceed the approved amount, including partial claims.
- Make request creation and reservation all-or-nothing; retries must resolve
  by idempotency key and payload equality.
- Implement single-use release/consume events with compare-and-set state
  transitions and unique action keys.

**Gate:** isolated concurrency/fault-injection tests prove no double reserve,
entry, release, or consumption.

### P3 — Implement referral issuance bridge and separate referral requests

- Make reward issuance and outbox creation one Firestore transaction.
- Add idempotent delivery/inbox and reconciliation before rewards are
  requestable from the canonical ledger.
- Reserve exact server-verified reward IDs only in a separate referral
  request; do not include them in trading calculations or requests.
- Implement only the approved refund/chargeback correction behavior.

**Gate:** outbox redelivery, partial failure, duplicate reservation, and
reversal tests pass; undelivered rewards remain unavailable.

### P4 — Implement authorized review and manual settlement state machine

- Add payout-specific authorization for owner history, destination access,
  review, rejection, transfer recording, success confirmation, and
  reconciliation.
- Enforce one-hour elapsed time before review on the server; never auto-approve
  or auto-pay.
- Implement conditional transitions for rejection/cancellation, confirmed
  failure, confirmed success, and `reconciliation_required`. Unknown outcomes
  retain reservations and cannot be retried until reconciled.
- Store evidence references privately, audit every actor/action, and reject
  duplicate confirmation/reference where policy requires.

**Gate:** isolated fake-adapter tests demonstrate success only after authorized
confirmation and preserve held funds through timeout/unknown outcomes.

### P5 — Reconcile history and operate recovery before migration/deployment

- Inventory legacy `withdrawableProfit`, payout history, rewards, and transfer
  evidence without treating any unknown amount/status as authoritative.
- Quarantine unmatched balances and uncertain historical payments; prepare a
  reviewable dry-run reconciliation with source evidence and ownership checks.
- Implement monitoring, bounded retries, dead-letter/error reporting, and
  operator reconciliation with no automatic financial settlement.
- Add privacy tests for public/account/history/admin endpoints and destination
  storage.

**Gate:** historical discrepancies are reviewed and separately approved;
deployment and any production data migration require separate explicit
authorization.

## 16. Test and implementation plan

All tests should use isolated in-memory/test Firestore and D1 databases, mocked
Firebase verification, fixed test identities, and a fake manual-transfer
evidence adapter. No test may contact production services, transfer money, or
write production balances.

1. **Accounting unit tests:** gross price PnL versus net costs; positive, zero,
   negative periods; cost allocation; corrections/reversals; rounding; split
   values 70/80/90 and invalid/missing values; phase/snapshot effective time.
   Do not write these formula tests until the missing policy is approved.
2. **Eligibility tests:** unauthenticated request; wrong owner; missing D1
   account/rule snapshot; unsupported split; open position; disabled/failed
   account; drawdown breach; insufficient trading days; stale/missing source
   data; and explicit unavailable result with no writes.
3. **Idempotency/concurrency tests:** same request key replay; changed payload
   under same key; two simultaneous requests for one claim; two requests for
   overlapping reward IDs; unique source-event ingestion; transaction rollback;
   unknown commit result queried before retry.
4. **Lifecycle tests:** request enters waiting; review before one hour denied;
   review after one hour permitted but not automatic approval; authorized and
   unauthorized transitions; rejection/cancellation release once; failed
   transfer release only after confirmed no-payment; timeout remains reserved
   in reconciliation; successful authorized evidence consumes once; duplicate
   success confirmation cannot double-consume.
5. **Referral tests:** $10 issuance idempotency; separate referral request;
   outbox redelivery; missing outbox reconciliation; reward reservation
   conflict; refund/chargeback event behavior after policy approval; no
   inclusion in trading calculations.
6. **Integration/failure-injection tests:** Firestore outbox committed but D1
   unavailable; D1 committed but acknowledgement lost; retry/replay; stale
   reconciliation; mismatched totals; duplicate transfer reference; admin
   claim revoked; evidence inaccessible; no state change on each failed step.
7. **Migration tests:** unknown legacy balances remain unavailable; reconciled
   entries preserve source references; duplicate/owner-mismatched history is
   quarantined; migration rerun is idempotent.

## 17. Decisions/evidence required before implementation

Implementation can proceed only after the following are supplied or proven:

1. Authoritative, complete trading-cost/adjustment records and semantics.
2. Payout-period boundary and late-event/correction policy.
3. Negative-period/loss carry-forward, reset, and correction policy.
4. Exact eligibility rule contract: account status, drawdown breach, minimum
   trading/profitable days, open-position freshness, frequency, limits, and
   other account restrictions.
5. Immutable account phase/rule/split version semantics and authoritative
   effective snapshot.
6. Currency, conversion, precision, and rounding contract.
7. Repeat-withdrawal and reservation/release semantics across periods.
8. Payout minima/maxima, frequency, method fees, and fee allocation.
9. Referral request criteria plus refund/chargeback reversal policy and a
   durable authoritative source event.
10. Canonical request/reservation/audit store and cross-store outbox ownership.
11. Payout-specific admin role matrix, separation of duties, evidence
    requirements, duplicate/reversal handling, and uncertain-outcome
    adjudication.
12. A reconciled inventory and approved migration plan for historical
    `withdrawableProfit`, referral rewards, payout requests, and manual
    transfer evidence.

## 18. Safety conclusion

This proposal does not change runtime behavior. Trading `realized_pnl` is not
verified net payout profit; account rules are not an immutable payout-period
snapshot; there is no complete eligibility evaluator, request/reservation
ledger, or manual settlement workflow. Therefore payout eligibility remains
unavailable and `POST /api/payouts/requests` remains blocked with
`503 payout_eligibility_unavailable`. Referral rewards remain separate and
unsettled. Approval of this design alone would not authorize production
implementation, data migration, or deployment.
