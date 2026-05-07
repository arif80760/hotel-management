-- ===========================================================================
-- Migration: Multi-Room Enum Preparation
-- File:    sql/migrations/2026-05-08-multi-room-enum-prep.sql
-- Date:    2026-05-08
--
-- MUST RUN FIRST — before foundation.sql — in its own session.
--
-- Adds 'checked_out_early' to the booking_status enum.
-- PostgreSQL commits enum additions immediately (statement-level commit),
-- but the new value cannot be used within the same session it was added.
-- Running this file first, in a separate session, ensures the value is
-- fully committed and visible before foundation.sql tries to INSERT it.
--
-- Run order:
--   1. This file   (enum-prep.sql)   — separate session, commits immediately
--   2. foundation.sql                — separate session, uses the new value
--   3. rpc.sql                       — separate session, depends on new tables
-- ===========================================================================

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'checked_out_early';
