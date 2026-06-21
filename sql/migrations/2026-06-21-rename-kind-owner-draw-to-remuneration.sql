update public.expense_categories set kind = 'remuneration' where kind = 'owner_draw';
comment on column public.expense_categories.kind is 'operating | remuneration. remuneration = MD/Chairman/Director payment: cash-out but EXCLUDED from operating-expense/profit totals (appropriation of profit). Validated at app layer.';
