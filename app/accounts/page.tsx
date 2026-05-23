// app/accounts/page.tsx
//
// Accounts root — has no UI of its own. Auto-redirects to the first
// child route (Cashbook). The other Accounts children — Expense,
// Payroll, Revenue Management — have their own /accounts/<name> routes.

import { redirect } from "next/navigation";

export default function AccountsPage() {
  redirect("/accounts/cashbook");
}
