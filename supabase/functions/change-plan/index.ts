import Stripe from "npm:stripe@18.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.53.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const PLAN_HIERARCHY = {
  'trial': 0,
  'monthly': 1,
  'semiannual': 2,
  'annual': 3
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader! } } }
    );
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', { apiVersion: '2023-10-16' });

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) throw new Error('Unauthorized');

    const { newPlanType, newPriceId, paymentMethodId } = await req.json();
    if (!newPriceId || !newPlanType) throw new Error('Missing required parameters');

    const { data: currentSub } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!currentSub) {
      throw new Error('No subscription found. Please create a new subscription from the upgrade page.');
    }

    const stripeCustomerId = currentSub.stripe_customer_id;
    if (!stripeCustomerId) throw new Error('No Stripe customer found');

    if (paymentMethodId) {
      try {
        await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: { default_payment_method: paymentMethodId }
        });
      } catch (e: any) {
        if (!e.message.includes('attached')) throw e;
      }
    }

    const stripeSubscriptionId = currentSub.stripe_subscription_id;
    if (!stripeSubscriptionId) {
      throw new Error('No active Stripe subscription found. Please purchase a new plan from the upgrade page.');
    }

    let stripeSubscription;
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (e) {
      throw new Error('Stripe subscription not found. Please purchase a new plan from the upgrade page.');
    }

    const stripeStatus = stripeSubscription.status;
    const isCanceled = stripeStatus === 'canceled';
    const isExpired = new Date(stripeSubscription.current_period_end * 1000) <= new Date();
    const isCurrentlyTrial = currentSub.plan_type === 'trial' || stripeStatus === 'trialing';

    if (isCanceled && isExpired) {
      console.log('Subscription is canceled and expired - creating new subscription');
      const newSubscription = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [{ price: newPriceId }],
        default_payment_method: paymentMethodId,
        metadata: {
          user_id: user.id,
          plan_type: newPlanType,
          is_trial: 'false'
        }
      });

      await supabaseAdmin.from('subscriptions').update({
        plan_type: newPlanType,
        status: newSubscription.status,
        stripe_subscription_id: newSubscription.id,
        current_period_start: new Date(newSubscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(newSubscription.current_period_end * 1000).toISOString(),
        cancel_at_period_end: false,
        updated_at: new Date().toISOString()
      }).eq('id', currentSub.id);

      const latestInvoice = await stripe.invoices.retrieve(newSubscription.latest_invoice as string);
      const clientSecret = (latestInvoice.payment_intent as any)?.client_secret;

      return new Response(JSON.stringify({
        success: true,
        requiresPayment: true,
        clientSecret: clientSecret
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const currentPlanLevel = PLAN_HIERARCHY[currentSub.plan_type as keyof typeof PLAN_HIERARCHY] || 0;
    const newPlanLevel = PLAN_HIERARCHY[newPlanType as keyof typeof PLAN_HIERARCHY] || 0;
    const isUpgrade = newPlanLevel > currentPlanLevel;

    const hasIntervalChange = (currentSub.plan_type === 'monthly' && newPlanType !== 'monthly') ||
                              (currentSub.plan_type !== 'monthly' && newPlanType === 'monthly') ||
                              (currentSub.plan_type === 'semiannual' && newPlanType === 'annual') ||
                              (currentSub.plan_type === 'annual' && newPlanType === 'semiannual');

    console.log('Plan change detected:', {
      from: currentSub.plan_type,
      to: newPlanType,
      isUpgrade,
      isTrial: isCurrentlyTrial,
      hasIntervalChange
    });

    const updateParams: any = {
      items: [{ id: stripeSubscription.items.data[0].id, price: newPriceId }],
      metadata: {
        ...stripeSubscription.metadata,
        plan_type: newPlanType,
        is_trial: 'false'
      }
    };

    if (isCurrentlyTrial && newPlanType !== 'trial') {
      console.log('Converting trial to paid plan - charging immediately');
      updateParams.trial_end = 'now';
      updateParams.proration_behavior = 'create_prorations';
      updateParams.billing_cycle_anchor = 'now';
    } else if (hasIntervalChange) {
      console.log('Changing billing interval - starting new billing cycle with proration');
      updateParams.proration_behavior = 'create_prorations';
      updateParams.billing_cycle_anchor = 'now';
    } else if (isUpgrade) {
      console.log('Upgrading plan - prorating and charging immediately, maintaining billing cycle');
      updateParams.proration_behavior = 'create_prorations';
      updateParams.billing_cycle_anchor = 'unchanged';
    } else {
      console.log('Downgrading plan - scheduling change for next billing period');
      updateParams.proration_behavior = 'none';
      updateParams.billing_cycle_anchor = 'unchanged';
    }

    const updatedSubscription = await stripe.subscriptions.update(stripeSubscriptionId, updateParams);

    const isDowngrade = newPlanLevel < currentPlanLevel && !hasIntervalChange;

    const dbUpdate: any = {
      status: updatedSubscription.status,
      current_period_start: new Date(updatedSubscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(updatedSubscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: false,
      updated_at: new Date().toISOString()
    };

    if (!isDowngrade) {
      dbUpdate.plan_type = newPlanType;
    }

    await supabaseAdmin.from('subscriptions').update(dbUpdate).eq('id', currentSub.id);

    if (isCurrentlyTrial || isUpgrade || hasIntervalChange) {
      const latestInvoice = await stripe.invoices.retrieve(updatedSubscription.latest_invoice as string);
      const clientSecret = (latestInvoice.payment_intent as any)?.client_secret;

      if (clientSecret) {
        let message = 'Plan changed successfully.';
        if (isCurrentlyTrial) {
          message = 'Trial converted to paid plan.';
        } else if (hasIntervalChange) {
          message = 'Billing interval changed. You\'ll be charged the prorated amount for the new plan.';
        } else if (isUpgrade) {
          message = 'Plan upgraded. You\'ll be charged the prorated difference.';
        }

        return new Response(JSON.stringify({
          success: true,
          requiresPayment: true,
          clientSecret: clientSecret,
          message: message
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      requiresPayment: false,
      message: 'Plan change will take effect at the end of your current billing period.'
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: any) {
    console.error('Change plan error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400
    });
  }
});
