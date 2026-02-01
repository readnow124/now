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
    const { subscriptionId } = await req.json();

    const { data: currentSub } = await supabaseClient
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .eq('user_id', user.id)
      .single();

    if (!currentSub) throw new Error('Subscription not found');

    if (!currentSub.stripe_subscription_id) {
      throw new Error('No Stripe subscription found');
    }

    console.log('Setting cancel_at_period_end to true for subscription:', currentSub.stripe_subscription_id);
    await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    await supabaseClient.from('subscriptions').update({
      cancel_at_period_end: true,
      status: 'cancelled',
      updated_at: new Date().toISOString()
    }).eq('id', subscriptionId);

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscription will be canceled at the end of the billing period'
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });

  } catch (error: any) {
    console.error('Cancel subscription error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400
    });
  }
});
