-- =============================================================
-- 2026-06-07-room-analytics-rpcs.sql
-- Read-only analytics RPCs powering the Room Analytics dashboard
-- (/rooms/analytics). Both read from booking_rooms (the per-room
-- grain), exclude cancelled bookings, and pro-rate nights/revenue
-- to the nights that fall inside [p_from, p_to].
--
--   room_analytics_by_room(from, to) — one row per room: bookings,
--     occupied/available nights, revenue, ADR, RevPAR, occupancy%.
--     Returns room_status so the app can exclude maintenance rooms
--     from KPI denominators. ADR is NULL for never-booked rooms.
--   room_occupancy_trend(from, to)  — one row per day: occupied vs
--     available rooms (maintenance excluded from available) and
--     occupancy%. Counts DISTINCT rooms per night, so it caps at 100%.
--
-- Revenue basis is booking_rate × nights (room revenue only; excludes
-- extra charges and checkout discounts), so ADR/RevPAR stay true to
-- standard hotel definitions.
-- =============================================================

CREATE OR REPLACE FUNCTION public.room_analytics_by_room(p_from date, p_to date)
RETURNS TABLE (
  room_id uuid, room_number text, floor smallint, category text,
  room_status text, price_per_night numeric, bookings bigint,
  occupied_nights bigint, available_nights integer, revenue numeric,
  adr numeric, revpar numeric, occupancy_pct numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT (p_to - p_from + 1)::int AS avail_nights
  ),
  -- aggregate REAL booking_rooms rows only, so no NULL-row arithmetic
  br_agg AS (
    SELECT
      br.room_id,
      SUM(GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from))) AS occupied_nights,
      COUNT(*) FILTER (WHERE GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from)) > 0) AS bookings,
      SUM(GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from)) * br.booking_rate) AS revenue
    FROM public.booking_rooms br
    WHERE br.status <> 'cancelled'
      AND br.check_in_date <= p_to
      AND COALESCE(br.actual_checkout_date, br.check_out_date) > p_from
    GROUP BY br.room_id
  )
  SELECT
    r.id, r.room_number, r.floor, r.category, r.status::text, r.price_per_night,
    COALESCE(a.bookings, 0)        AS bookings,
    COALESCE(a.occupied_nights, 0) AS occupied_nights,
    p.avail_nights                 AS available_nights,
    COALESCE(a.revenue, 0)         AS revenue,
    CASE WHEN COALESCE(a.occupied_nights,0) > 0
         THEN ROUND(a.revenue / a.occupied_nights, 2) END AS adr,
    CASE WHEN p.avail_nights > 0
         THEN ROUND(COALESCE(a.revenue,0) / p.avail_nights, 2) END AS revpar,
    CASE WHEN p.avail_nights > 0
         THEN ROUND(100.0 * COALESCE(a.occupied_nights,0) / p.avail_nights, 1) END AS occupancy_pct
  FROM public.rooms r
  CROSS JOIN params p
  LEFT JOIN br_agg a ON a.room_id = r.id
  ORDER BY COALESCE(a.revenue,0) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.room_analytics_by_room(date, date) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.room_occupancy_trend(p_from date, p_to date)
RETURNS TABLE (
  day date,
  occupied_rooms integer,
  available_rooms integer,
  occupancy_pct numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS day
  ),
  avail AS (
    SELECT COUNT(*)::int AS available_rooms
    FROM public.rooms
    WHERE status <> 'maintenance'
  ),
  occ AS (
    SELECT d.day,
           COUNT(DISTINCT br.room_id) AS occupied_rooms
    FROM days d
    LEFT JOIN public.booking_rooms br
      ON br.status <> 'cancelled'
     AND br.check_in_date <= d.day
     AND COALESCE(br.actual_checkout_date, br.check_out_date) > d.day
    GROUP BY d.day
  )
  SELECT
    o.day,
    o.occupied_rooms::int,
    a.available_rooms,
    CASE WHEN a.available_rooms > 0
         THEN ROUND(100.0 * o.occupied_rooms / a.available_rooms, 1) END AS occupancy_pct
  FROM occ o CROSS JOIN avail a
  ORDER BY o.day;
$$;

GRANT EXECUTE ON FUNCTION public.room_occupancy_trend(date, date) TO authenticated, service_role;
