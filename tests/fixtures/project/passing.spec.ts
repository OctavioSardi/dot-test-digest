import { describe, expect, it } from "vitest";
import { makeCart } from "./src/cart.js";

describe("cart", () => {
  it("starts empty", () => {
    expect(makeCart().items).toHaveLength(0);
  });

  it("adds items", () => {
    expect(makeCart().add("apple").items).toEqual(["apple"]);
  });
});
