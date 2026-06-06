-- 2026-06-02-inventory-multi-unit.sql — optional purchase pack (box/case) per item.
-- Stock is always tracked in the base unit; a pack just lets purchases be entered
-- in larger units. units_per_pack = how many base units in one pack.

alter table public.inventory_items
  add column if not exists pack_label     text,
  add column if not exists units_per_pack numeric(12,2);

alter table public.inventory_items
  drop constraint if exists chk_inventory_items_units_per_pack;
alter table public.inventory_items
  add constraint chk_inventory_items_units_per_pack
  check (units_per_pack is null or units_per_pack > 0);

comment on column public.inventory_items.pack_label is
  'Optional purchase-pack label (e.g. box, case). Null = no pack; purchases entered in the base unit.';
comment on column public.inventory_items.units_per_pack is
  'Base units per pack (e.g. 24 pieces per box). Null when no pack.';
