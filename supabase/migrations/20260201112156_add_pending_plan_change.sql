/*
  # Add Pending Plan Change Support

  Adds field to track pending plan downgrades that will take effect at period end.

  ## Changes
  - Add `pending_plan_change` JSONB field to subscriptions table
    - Stores: { plan_type: string, price_id: string, requested_at: timestamp }
  - Allows professional downgrade flow without immediate charges
*/

ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS pending_plan_change jsonb DEFAULT NULL;

COMMENT ON COLUMN subscriptions.pending_plan_change IS 'Stores pending plan downgrade that will take effect at period end';
