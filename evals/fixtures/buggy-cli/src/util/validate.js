export function validateTitle(title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  return title.trim();
}

// BUG 005: async race — loadAsync resolves before write completes because
// writeFile callback style is never awaited. Callers see stale data.
import { writeFile } from "node:fs";
export function saveAsync(path, data) {
  return new Promise((resolve) => {
    writeFile(path, data, () => {});
    resolve();
  });
}
