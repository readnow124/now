/*
  # Add trial_end column to subscriptions

  1. Modified Tables
    - `subscriptions`
      - Added `trial_end` (timestamptz, nullable) - Stores the actual trial expiry date from Stripe
  
  2. Notes
    - Stripe's `current_period_end` represents the billing cycle end, not the trial end
    - For trialing subscriptions, `trial_end` stores the correct 30-day expiry
    - The billing page should display `trial_end` instead of `current_period_end` for trials
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'trial_end'
  ) THEN
    ALTER TABLE subscriptions ADD COLUMN trial_end timestamptz;
  END IF;
END $$;