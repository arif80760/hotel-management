// lib/amountToWords.ts
//
// Convert a numeric amount (Taka) into its written-out form for printing
// on payment vouchers. Two outputs:
//
//   amountToEnglishLakh(123456)  → "Taka One Lakh Twenty Three Thousand Four Hundred Fifty Six only"
//   amountToBengali(123456)      → "টাকা এক লক্ষ তেইশ হাজার চারশত ছাপ্পান্ন মাত্র"
//
// Both follow Bangladeshi numbering conventions (lakh = 100,000; crore =
// 10,000,000). The English version uses British/Indian/Bangladeshi spellings
// (Lakh, Crore) — not American thousands/millions.
//
// Paisa (decimals): if the input has a fractional part, it's rendered as
// "and N Paisa" (English) / "এবং N পয়সা" (Bengali). Whole amounts skip
// the paisa clause.
//
// Negative amounts are not supported; voucher amounts are always positive
// by domain definition (expense_out CHECK constraint).
//
// ─────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// English (Indian/Bangladeshi convention) — lakh/crore
// ─────────────────────────────────────────────────────────────

const EN_ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen"
];
const EN_TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"
];

// Convert 0..99 to words
function enUnder100(n: number): string {
  if (n < 20) return EN_ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? EN_TENS[tens] : `${EN_TENS[tens]} ${EN_ONES[ones]}`;
}

// Convert 0..999 to words (with "Hundred" for the hundreds digit)
function enUnder1000(n: number): string {
  if (n === 0) return "";
  if (n < 100) return enUnder100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const restStr = rest === 0 ? "" : ` ${enUnder100(rest)}`;
  return `${EN_ONES[hundreds]} Hundred${restStr}`;
}

/**
 * Convert a non-negative number to its English (Bangladeshi) word form,
 * up to crore scale. Returns the words for the integer part only — the
 * caller wraps it with "Taka ... only" and optional paisa.
 *
 * Supports up to 99,99,99,999 (about 1000 crore). Larger amounts (very
 * unlikely for a hotel voucher) are clamped at the highest digit.
 */
function enIntegerToWords(n: number): string {
  if (n === 0) return "Zero";

  const crore     = Math.floor(n / 10000000);   // 10^7
  const lakh      = Math.floor((n % 10000000) / 100000);  // 10^5
  const thousand  = Math.floor((n % 100000) / 1000);
  const rest      = n % 1000;

  const parts: string[] = [];
  if (crore    > 0) parts.push(`${enUnder1000(crore)} Crore`);
  if (lakh     > 0) parts.push(`${enUnder1000(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${enUnder1000(thousand)} Thousand`);
  if (rest     > 0) parts.push(enUnder1000(rest));

  return parts.join(" ");
}

/**
 * Full voucher line in English (Bangladeshi). Wraps "Taka X only" with
 * optional "and Y Paisa" if there's a fractional component.
 */
export function amountToEnglishLakh(amount: number): string {
  const safe = Math.max(0, Math.round(amount * 100) / 100);
  const integer  = Math.floor(safe);
  const paisa    = Math.round((safe - integer) * 100);

  const intWords = enIntegerToWords(integer);
  if (paisa === 0) {
    return `Taka ${intWords} only`;
  }
  const paisaWords = enUnder100(paisa);
  return `Taka ${intWords} and ${paisaWords} Paisa only`;
}


// ─────────────────────────────────────────────────────────────
// Bengali (Bangla script)
// ─────────────────────────────────────────────────────────────

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

// 0..99 in Bangla words. Bangla has irregular forms for each two-digit
// number under 100 — there's no clean "twenty + three" pattern as in English.
// So we encode a 100-entry table.
const BN_UNDER_100: string[] = [
  "শূন্য", "এক", "দুই", "তিন", "চার", "পাঁচ", "ছয়", "সাত", "আট", "নয়",
  "দশ", "এগারো", "বারো", "তেরো", "চৌদ্দ", "পনেরো", "ষোলো", "সতেরো", "আঠারো", "ঊনিশ",
  "বিশ", "একুশ", "বাইশ", "তেইশ", "চব্বিশ", "পঁচিশ", "ছাব্বিশ", "সাতাশ", "আঠাশ", "ঊনত্রিশ",
  "ত্রিশ", "একত্রিশ", "বত্রিশ", "তেত্রিশ", "চৌত্রিশ", "পঁয়ত্রিশ", "ছত্রিশ", "সাঁইত্রিশ", "আটত্রিশ", "ঊনচল্লিশ",
  "চল্লিশ", "একচল্লিশ", "বিয়াল্লিশ", "তেতাল্লিশ", "চুয়াল্লিশ", "পঁয়তাল্লিশ", "ছেচল্লিশ", "সাতচল্লিশ", "আটচল্লিশ", "ঊনপঞ্চাশ",
  "পঞ্চাশ", "একান্ন", "বায়ান্ন", "তিপ্পান্ন", "চুয়ান্ন", "পঞ্চান্ন", "ছাপ্পান্ন", "সাতান্ন", "আটান্ন", "ঊনষাট",
  "ষাট", "একষট্টি", "বাষট্টি", "তেষট্টি", "চৌষট্টি", "পঁয়ষট্টি", "ছিষট্টি", "সাতষট্টি", "আটষট্টি", "ঊনসত্তর",
  "সত্তর", "একাত্তর", "বাহাত্তর", "তিয়াত্তর", "চুয়াত্তর", "পঁচাত্তর", "ছিয়াত্তর", "সাতাত্তর", "আটাত্তর", "ঊনআশি",
  "আশি", "একাশি", "বিরাশি", "তিরাশি", "চুরাশি", "পঁচাশি", "ছিয়াশি", "সাতাশি", "আটাশি", "ঊননব্বই",
  "নব্বই", "একানব্বই", "বিরানব্বই", "তিরানব্বই", "চুরানব্বই", "পঁচানব্বই", "ছিয়ানব্বই", "সাতানব্বই", "আটানব্বই", "নিরানব্বই"
];

// 0..999 in Bangla — "X শত Y" form
function bnUnder1000(n: number): string {
  if (n < 100) return BN_UNDER_100[n];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const hWord = `${BN_UNDER_100[hundreds]}শত`;
  return rest === 0 ? hWord : `${hWord} ${BN_UNDER_100[rest]}`;
}

function bnIntegerToWords(n: number): string {
  if (n === 0) return BN_UNDER_100[0];

  const crore     = Math.floor(n / 10000000);
  const lakh      = Math.floor((n % 10000000) / 100000);
  const thousand  = Math.floor((n % 100000) / 1000);
  const rest      = n % 1000;

  const parts: string[] = [];
  if (crore    > 0) parts.push(`${bnUnder1000(crore)} কোটি`);
  if (lakh     > 0) parts.push(`${bnUnder1000(lakh)} লক্ষ`);
  if (thousand > 0) parts.push(`${bnUnder1000(thousand)} হাজার`);
  if (rest     > 0) parts.push(bnUnder1000(rest));

  return parts.join(" ");
}

/**
 * Convert digits 0-9 in a string to Bangla digits ০-৯.
 */
export function toBengaliDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => BN_DIGITS[parseInt(d, 10)]);
}

/**
 * Full voucher line in Bengali. Format:
 *   "টাকা <words> মাত্র"           — whole amount
 *   "টাকা <words> এবং <p> পয়সা মাত্র"  — with paisa
 */
export function amountToBengali(amount: number): string {
  const safe = Math.max(0, Math.round(amount * 100) / 100);
  const integer = Math.floor(safe);
  const paisa = Math.round((safe - integer) * 100);

  const intWords = bnIntegerToWords(integer);
  if (paisa === 0) {
    return `টাকা ${intWords} মাত্র`;
  }
  const paisaWords = BN_UNDER_100[paisa];
  return `টাকা ${intWords} এবং ${paisaWords} পয়সা মাত্র`;
}
