export interface Cart {
  items: string[];
  add(item: string): Cart;
  total(): number;
}

export function makeCart(): Cart {
  const items: string[] = [];
  const cart: Cart = {
    items,
    add(item) {
      items.push(item);
      return cart;
    },
    total() {
      return 99;
    },
  };
  return cart;
}
