import { calcTotal, type Item, type PriceOptions } from "./pricing";

export function cartSummary(
  items: Item[],
  opts: PriceOptions = { taxRate: 0 },
): string {
  return `${items.length} items\nTotal: ${calcTotal(items, opts).toFixed(2)}`;
}
