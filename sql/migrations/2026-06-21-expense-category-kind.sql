alter table public.expense_categories add column if not exists kind text not null default 'operating';
comment on column public.expense_categories.kind is 'operating | owner_draw. owner_draw = MD/Chairman/Director withdrawal: cash-out but EXCLUDED from operating-expense/profit totals. Validated at app layer.';
