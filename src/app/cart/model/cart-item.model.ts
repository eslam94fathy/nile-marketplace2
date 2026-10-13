/** One cart line: only the variant and its quantity, everything else is read live (spec 08 §1). */
export interface CartItem {
  id: string;
  variantId: string;
  quantity: number;
}

/** What checkout reads from the cart (spec 08 §2 `getLinesForCheckout`). */
export interface CheckoutLine {
  variantId: string;
  quantity: number;
}
