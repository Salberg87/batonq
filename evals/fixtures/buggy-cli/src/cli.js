#!/usr/bin/env node
import { addCommand } from "./commands/add.js";
import { listCommand } from "./commands/list.js";
import { removeCommand } from "./commands/remove.js";

const [, , cmd, ...rest] = process.argv;

const commands = {
  add: addCommand,
  list: listCommand,
  remove: removeCommand,
};

const fn = commands[cmd];
if (!fn) {
  console.error(`unknown command: ${cmd ?? "<none>"}`);
  // BUG 004: wrong exit code on unknown command (should be non-zero).
  process.exit(0);
}

const result = fn(rest);
if (result && typeof result.then === "function") {
  result.catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
