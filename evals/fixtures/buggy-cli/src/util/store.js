import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(process.cwd(), ".todos.json");

export function readStore() {
  if (!existsSync(PATH)) return { items: [] };
  return JSON.parse(readFileSync(PATH, "utf8"));
}

export function writeStore(store) {
  writeFileSync(PATH, JSON.stringify(store, null, 2));
}
