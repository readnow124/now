import Stripe from "npm:stripe@18.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.53.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) throw new Error('Unauthorized');

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', { apiVersion: '2023-10-16' });
    const { subscriptionId, paymentMethodId, priceId } = await req.json();

    const { data: currentSub } = await supabaseClient.from('subscriptions').select('*').eq('id', subscriptionId).eq('user_id', user.id).single();
    if (!currentSub) throw new Error('Subscription not found');

    const now = new Date();
    const periodEnd = new Date(currentSub.current_period_end);
    const isExpired = periodEnd <= now;

    if (isExpired) {
      throw new Error('Subscription has expired. Please purchase a new plan from the upgrade page.');
    }

    if (!currentSub.stripe_subscription_id) {
      throw new Error('No Stripe subscription found. Please purchase a new plan from the upgrade page.');
    }

    let stripeSubscription;
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(currentSub.stripe_subscription_id);
    } catch {
      throw new Error('Subscription not found in Stripe. Please purchase a new plan from the upgrade page.');
    }

    const stripeStatus = stripeSubscription.status;

    if (stripeStatus === 'active' || stripeStatus === 'trialing') {
      console.log('✅ Resuming auto-renewal for active/trialing subscription - no charge');
      await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
        cancel_at_period_end: false,
        default_payment_method: paymentMethodId
      });

      await supabaseClient.from('subscriptions').update({
        status: 'active',
        cancel_at_period_end: false,
        updated_at: new Date().toISOString()
      }).eq('id', subscriptionId);
    } else if (stripeStatus === 'canceled') {
      console.log('⚠️ Subscription is fully canceled - creating new subscription with remaining time');
      const remainingSeconds = Math.floor((periodEnd.getTime() - now.getTime()) / 1000);
      const trialEnd = remainingSeconds > 0 ? Math.floor(periodEnd.getTime() / 1000) : undefined;

      const newSubscription = await stripe.subscriptions.create({
        customer: currentSub.stripe_customer_id,
        items: [{ price: priceId }],
        default_payment_method: paymentMethodId,
        trial_end: trialEnd,
        metadata: {
          user_id: user.id,
          plan_type: currentSub.plan_type,
          is_trial: String(currentSub.plan_type === 'trial')
        }
      });

      await supabaseClient.from('subscriptions').update({
        status: 'active',
        stripe_subscription_id: newSubscription.id,
        cancel_at_period_end: false,
        current_period_start: new Date(newSubscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(newSubscription.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', subscriptionId);
    } else {
      throw new Error('Cannot reactivate subscription in current state. Please purchase a new plan from the upgrade page.');
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
  }
});