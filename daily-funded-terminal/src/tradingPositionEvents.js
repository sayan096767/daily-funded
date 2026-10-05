export function applyPositionEvent(state, event) {
  if (!state || !event || typeof event !== "object" || typeof event.position_id !== "string") {
    return state;
  }

  const closedIds = new Set(state.closedIds || []);
  if (event.type === "POSITION_CLOSED") {
    closedIds.add(event.position_id);
    return {
      ...state,
      closedIds,
      positions: (state.positions || []).filter((position) => position.id !== event.position_id),
      trades: event.trade
        ? [event.trade, ...(state.trades || []).filter((trade) => trade.id !== event.trade.id)]
        : state.trades,
      account: event.account ? { ...state.account, ...event.account } : state.account,
    };
  }

  if (
    !["POSITION_OPENED", "POSITION_MODIFIED"].includes(event.type) ||
    closedIds.has(event.position_id) ||
    !event.position ||
    event.position.id !== event.position_id ||
    event.position.status !== "open"
  ) return state;

  return {
    ...state,
    closedIds,
    positions: [
      event.position,
      ...(state.positions || []).filter((position) => position.id !== event.position_id),
    ],
  };
}
