-- 2026-06-02-loans.sql — Stage 6: loans table + wire account_transactions.loan_id FK.
-- A loan = money the hotel borrows from a third party. Principal only, no interest.
-- Repaid-so-far / outstanding are DERIVED from linked loan_repayment transactions.

create table if not exists public.loans (
  id             uuid primary key default gen_random_uuid(),
  lender_name    text not null,
  principal      numeric(12,2) not null check (principal > 0),
  received_date  date not null,
  due_date       date,
  note           text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.loans is
  'Third-party loans the hotel borrows. Repayment tracked via account_transactions of type loan_repayment linked by loan_id. Principal only, no interest. Status (outstanding/repaid) is derived, not stored.';

alter table public.account_transactions drop constraint if exists fk_txn_loan;
alter table public.account_transactions
  add constraint fk_txn_loan
  foreign key (loan_id) references public.loans(id) on delete set null;

create index if not exists idx_account_transactions_loan_id
  on public.account_transactions (loan_id) where loan_id is not null;

alter table public.loans enable row level security;

drop policy if exists "Loans select — admin only" on public.loans;
create policy "Loans select — admin only"
  on public.loans for select using (public.current_user_role() = 'admin');

drop policy if exists "Loans insert — admin only" on public.loans;
create policy "Loans insert — admin only"
  on public.loans for insert with check (public.current_user_role() = 'admin');

drop policy if exists "Loans update — admin only" on public.loans;
create policy "Loans update — admin only"
  on public.loans for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

drop policy if exists "Loans delete — admin only" on public.loans;
create policy "Loans delete — admin only"
  on public.loans for delete using (public.current_user_role() = 'admin');
