// Money is stored in kobo (whole numbers). 1 naira = 100 kobo.
export function naira(kobo: number): string {
  return `\u20a6${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}
