import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeNonEmptyString,
  normalizeNullableString,
} from "../utils/strings.js";

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

describe("normalizeNullableString", () => {
  it("trims non-empty values", () => {
    assert.equal(normalizeNullableString("  value  "), "value");
  });

  it("returns null for blank or missing values", () => {
    assert.equal(normalizeNullableString("   "), null);
    assert.equal(normalizeNullableString(""), null);
    assert.equal(normalizeNullableString(undefined), null);
    assert.equal(normalizeNullableString(null), null);
  });
});
