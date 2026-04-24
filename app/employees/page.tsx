// app/employees/page.tsx
// Thin server wrapper — all state and UI live in EmployeesClient.

import EmployeesClient from "./EmployeesClient";

export default function EmployeesPage() {
  return <EmployeesClient />;
}
