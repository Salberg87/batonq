import { readStore, writeStore } from "../util/store.js";

export function removeCommand(args) {
  const raw = args[0];
  // BUG 001: null deref when no argument passed — parseInt(undefined) -> NaN,
  // then `.id === NaN` is always false, so nothing removed and no error.
  const id = parseInt(raw, 10);
  const store = readStore();
  const before = store.items.length;
  store.items = store.items.filter((it) => it.id !== id);
  writeStore(store);
  const after = store.items.length;
  console.log(`removed ${before - after} item(s)`);
}
