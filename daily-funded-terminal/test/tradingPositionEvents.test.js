import assert from "node:assert/strict";
import test from "node:test";
import { applyPositionEvent } from "../src/tradingPositionEvents.js";

const position = (id, overrides = {}) => ({
  id,
  status: "open",
  account_id: "ACC_1",
  ...overrides,
});

test("a confirmed open is applied immediately and an unsuccessful request has no event to apply", () => {
  const initial = { positions: [], trades: [], account: { balance: 1000 }, closedIds: new Set() };
  const opened = applyPositionEvent(initial, {
    type: "POSITION_OPENED",
    position_id: "POS_1",
    position: position("POS_1"),
  });

  assert.deepEqual(opened.positions, [position("POS_1")]);
  assert.deepEqual(applyPositionEvent(initial, null), initial);
  assert.deepEqual(initial.positions, []);
});

test("a failed manual close leaves the position visible", () => {
  const initial = { positions: [position("POS_1")], trades: [], closedIds: new Set() };
  assert.deepEqual(applyPositionEvent(initial, null), initial);
  assert.deepEqual(initial.positions, [position("POS_1")]);
});

test("close removes only its position and immediately applies authoritative trade/account data", () => {
  const initial = {
    positions: [position("POS_1"), position("POS_2")],
    trades: [],
    account: { balance: 1000, equity: 1000 },
    closedIds: new Set(),
  };
  const trade = { id: "TRD_1", realized_pnl: 15 };
  const closed = applyPositionEvent(initial, {
    type: "POSITION_CLOSED",
    position_id: "POS_1",
    position: { ...position("POS_1"), status: "closed" },
    trade,
    account: { balance: 1015, equity: 1010 },
  });

  assert.deepEqual(closed.positions, [position("POS_2")]);
  assert.deepEqual(closed.trades, [trade]);
  assert.deepEqual(closed.account, { balance: 1015, equity: 1010 });
});

test("duplicate close events are harmless and a late open/modify cannot resurrect a closed position", () => {
  const initial = { positions: [position("POS_1")], trades: [], closedIds: new Set() };
  const closeEvent = { type: "POSITION_CLOSED", position_id: "POS_1" };
  const once = applyPositionEvent(initial, closeEvent);
  const twice = applyPositionEvent(once, closeEvent);

  assert.deepEqual(twice.positions, []);
  assert.equal(applyPositionEvent(twice, {
    type: "POSITION_MODIFIED",
    position_id: "POS_1",
    position: position("POS_1", { stop_loss: 1.2 }),
  }), twice);
});

test("modification updates its own position without disturbing other positions", () => {
  const initial = { positions: [position("POS_1"), position("POS_2")], closedIds: new Set() };
  const modifiedPosition = position("POS_1", { stop_loss: 1.2 });
  const modified = applyPositionEvent(initial, {
    type: "POSITION_MODIFIED",
    position_id: "POS_1",
    position: modifiedPosition,
  });

  assert.deepEqual(modified.positions, [modifiedPosition, position("POS_2")]);
});
