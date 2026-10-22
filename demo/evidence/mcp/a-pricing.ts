export type Item = { price: number; qty: number };

export type PriceOptions = { taxRate: number };

export function calcTotal(items: Item[], opts: PriceOptions): number {
  const net = items.reduce((s, i) => s + i.price * i.qty, 0);
  return net * (1 + opts.taxRate);
}
