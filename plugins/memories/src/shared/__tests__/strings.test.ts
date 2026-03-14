import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeNonEmptyString } from "../utils/strings.js";

describe("normalizeNonEmptyString", () => {
  it("trims non-empty values", () => {
    assert.equal(normalizeNonEmptyString("  value  "), "value");
  });

  it("returns undefined for blank or missing values", () => {
    assert.equal(normalizeNonEmptyString("   "), undefined);
    assert.equal(normalizeNonEmptyString(""), undefined);
    assert.equal(normalizeNonEmptyString(undefined), undefined);
    assert.equal(normalizeNonEmptyString(null), undefined);
  });
});
