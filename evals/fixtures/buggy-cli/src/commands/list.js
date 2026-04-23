import { readStore } from "../util/store.js";

export function listCommand() {
  const store = readStore();
  // BUG 002: off-by-one — skips the last item.
  for (let i = 0; i < store.items.length - 1; i++) {
    const it = store.items[i];
    const mark = it.done ? "x" : " ";
    console.log(`[${mark}] ${it.id} ${it.title}`);
  }
}
