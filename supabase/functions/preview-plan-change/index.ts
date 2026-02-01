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

    const { newPlanType, newPriceId } = await req.json();
    if (!newPriceId || !newPlanType) throw new Error('Missing required parameters');

    const { data: currentSub } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!currentSub || !currentSub.stripe_subscription_id) {
      return new Response(JSON.stringify({
        isNewSubscription: true,
        amount: 0,
        currency: 'usd',
        message: 'This will be a new subscription.',
        prorationDate: null,
        nextBillingDate: null
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    let stripeSubscription;
    try {
      stripeSubscription = await stripe.subscriptions.retrieve(currentSub.stripe_subscription_id);
    } catch (e) {
      throw new Error('Subscription not found');
    }

    const stripeStatus = stripeSubscription.status;
    const isCanceled = stripeStatus === 'canceled';
    const isExpired = new Date(stripeSubscription.current_period_end * 1000) <= new Date();
    const isCurrentlyTrial = currentSub.plan_type === 'trial' || stripeStatus === 'trialing';

    if (isCanceled && isExpired) {
      return new Response(JSON.stringify({
        isNewSubscription: true,
        amount: 0,
        currency: stripeSubscription.currency || 'usd',
        message: 'Your subscription has expired. This will create a new subscription.',
        prorationDate: null,
        nextBillingDate: null
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const currentPlanLevel = PLAN_HIERARCHY[currentSub.plan_type as keyof typeof PLAN_HIERARCHY] || 0;
    const newPlanLevel = PLAN_HIERARCHY[newPlanType as keyof typeof PLAN_HIERARCHY] || 0;
    const isUpgrade = newPlanLevel > currentPlanLevel;
    const isDowngrade = newPlanLevel < currentPlanLevel;

    const hasIntervalChange = (currentSub.plan_type === 'monthly' && newPlanType !== 'monthly') ||
                              (currentSub.plan_type !== 'monthly' && newPlanType === 'monthly') ||
                              (currentSub.plan_type === 'semiannual' && newPlanType === 'annual') ||
                              (currentSub.plan_type === 'annual' && newPlanType === 'semiannual');

    const periodEndDate = new Date(stripeSubscription.current_period_end * 1000);
    const periodEndFormatted = periodEndDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    if (isDowngrade) {
      return new Response(JSON.stringify({
        isNewSubscription: false,
        amount: 0,
        currency: stripeSubscription.currency || 'usd',
        message: `Your plan will change to ${newPlanType.charAt(0).toUpperCase() + newPlanType.slice(1)} Plan on ${periodEndFormatted}. You'll keep full access to your current plan until then. No charge today.`,
        changeType: 'downgrade',
        prorationDate: null,
        nextBillingDate: periodEndDate.toISOString(),
        currentPlan: currentSub.plan_type,
        newPlan: newPlanType,
        willChargeNow: false,
        currentPeriodEnd: periodEndDate.toISOString()
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    let upcomingInvoice;
    try {
      const subscriptionItems = [{
        id: stripeSubscription.items.data[0].id,
        price: newPriceId
      }];

      const invoiceParams: any = {
        customer: currentSub.stripe_customer_id,
        subscription: currentSub.stripe_subscription_id,
        subscription_items: subscriptionItems
      };

      if (isCurrentlyTrial && newPlanType !== 'trial') {
        invoiceParams.subscription_trial_end = 'now';
        invoiceParams.subscription_billing_cycle_anchor = 'now';
        invoiceParams.subscription_proration_behavior = 'create_prorations';
      } else if (hasIntervalChange) {
        invoiceParams.subscription_billing_cycle_anchor = 'now';
        invoiceParams.subscription_proration_behavior = 'create_prorations';
      } else if (isUpgrade) {
        invoiceParams.subscription_billing_cycle_anchor = 'unchanged';
        invoiceParams.subscription_proration_behavior = 'create_prorations';
      }

      upcomingInvoice = await stripe.invoices.retrieveUpcoming(invoiceParams);
    } catch (e: any) {
      console.error('Error retrieving upcoming invoice:', e);
      return new Response(JSON.stringify({
        error: 'Could not calculate preview',
        message: e.message
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    const amountDue = upcomingInvoice.amount_due || 0;
    const currency = upcomingInvoice.currency || 'usd';
    const nextBillingDate = new Date(upcomingInvoice.period_end * 1000);

    let message = '';
    let changeType = '';

    if (isCurrentlyTrial) {
      message = `Converting from trial to ${newPlanType} plan.`;
      changeType = 'trial_conversion';
    } else if (hasIntervalChange) {
      message = `Changing billing interval. New billing cycle starts immediately with prorated adjustment.`;
      changeType = 'interval_change';
    } else if (isUpgrade) {
      message = `Upgrading to ${newPlanType.charAt(0).toUpperCase() + newPlanType.slice(1)} Plan. You'll be charged the prorated difference based on your remaining billing period.`;
      changeType = 'upgrade';
    }

    return new Response(JSON.stringify({
      isNewSubscription: false,
      amount: amountDue,
      currency: currency,
      message: message,
      changeType: changeType,
      prorationDate: new Date().toISOString(),
      nextBillingDate: nextBillingDate.toISOString(),
      currentPlan: currentSub.plan_type,
      newPlan: newPlanType,
      willChargeNow: isCurrentlyTrial || isUpgrade || hasIntervalChange,
      currentPeriodEnd: periodEndDate.toISOString()
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: any) {
    console.error('Preview error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400
    });
  }
});
