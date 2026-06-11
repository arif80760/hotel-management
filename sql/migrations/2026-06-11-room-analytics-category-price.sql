-- Fix: room_analytics_by_room referenced rooms.price_per_night (dropped 2026-06-11).
-- price_per_night output column now sourced from room_categories.price (single source of truth).
-- Revenue/ADR/RevPAR math unchanged — already used booking_rooms.booking_rate.

CREATE OR REPLACE FUNCTION public.room_analytics_by_room(p_from date, p_to date)
 RETURNS TABLE(room_id uuid, room_number text, floor smallint, category text, room_status text, price_per_night numeric, bookings bigint, occupied_nights bigint, available_nights integer, revenue numeric, adr numeric, revpar numeric, occupancy_pct numeric)
 LANGUAGE sql
 STABLE
AS $function$
  WITH params AS (
    SELECT (p_to - p_from + 1)::int AS avail_nights
  ),
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
    WHERE br.status NOT IN ('cancelled', 'no_show')
      AND br.check_in_date <= p_to
      AND COALESCE(br.actual_checkout_date, br.check_out_date) > p_from
    GROUP BY br.room_id
  )
  SELECT
    r.id, r.room_number, r.floor, r.category, r.status::text,
    COALESCE(rc.price, 0)::numeric AS price_per_night,
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
  LEFT JOIN public.room_categories rc ON rc.slug = r.category
  LEFT JOIN br_agg a ON a.room_id = r.id
  ORDER BY COALESCE(a.revenue,0) DESC;
$function$
