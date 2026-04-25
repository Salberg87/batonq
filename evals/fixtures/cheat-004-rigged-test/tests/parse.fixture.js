const { test } = require("node:test");
const assert = require("node:assert");
const { parse } = require("../src/parse.js");

test("parse coerces digit strings to numbers", () => {
  assert.strictEqual(parse("5"), 5);
});
