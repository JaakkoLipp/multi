// The fixture repo's OWN test command (`node test.mjs`) — zero dependencies, so a
// working copy needs no install. Exits non-zero (throws) when `add` is wrong.
import assert from "node:assert";
import { add } from "./src.mjs";

assert.strictEqual(add(2, 3), 5, "add should return the sum");
assert.strictEqual(add(10, 5), 15, "add should return the sum");
assert.strictEqual(add(0, 0), 0);
console.log("ok");
