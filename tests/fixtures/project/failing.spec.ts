import { describe, expect, it } from "vitest";
import { makeCart } from "./src/cart.js";

describe("cart totals", () => {
  it("totals an added item", () => {
    expect(makeCart().add("apple").total()).toBe(100);
  });
});
