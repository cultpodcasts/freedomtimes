-- Migration: 0006_candidate_decision_trace
-- Adds per-candidate decision trace fields for Stage 2 accept/reject auditing.

ALTER TABLE candidates ADD COLUMN decision_code TEXT;
ALTER TABLE candidates ADD COLUMN decision_detail TEXT;
