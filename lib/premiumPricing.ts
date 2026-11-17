// Displayed Premium prices, in USD cents. These are *copy*, not billing: the
// amount actually charged is whatever the Stripe Prices behind
// STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL say, so changing a price means
// creating a new Stripe Price AND updating the numbers here (and giving
// existing subscribers the 30 days' notice Terms section 6 promises).
export const PREMIUM_MONTHLY_CENTS = 799;
export const PREMIUM_ANNUAL_CENTS = 8000;

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What the annual plan saves over twelve monthly payments. */
export function annualSavings(): { cents: number; percent: number } {
  const monthlyForAYear = PREMIUM_MONTHLY_CENTS * 12;
  const cents = monthlyForAYear - PREMIUM_ANNUAL_CENTS;
  return { cents, percent: Math.round((cents / monthlyForAYear) * 100) };
}
