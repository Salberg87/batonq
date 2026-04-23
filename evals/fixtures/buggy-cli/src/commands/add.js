import { readStore, writeStore } from "../util/store.js";
import { validateTitle } from "../util/validate.js";

export function addCommand(args) {
  const title = args.join(" ").trim();
  // BUG 003: missing validation — empty title silently accepted.
  // validateTitle(title) should be called here and throw on empty input.
  const store = readStore();
  const id = store.items.length + 1;
  store.items.push({ id, title, done: false });
  writeStore(store);
  console.log(`added #${id}: ${title}`);
}
