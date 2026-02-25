import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle, ArrowLeft, ArrowRight, Shield, Loader2, AlertCircle, Crown
} from 'lucide-react';
import { SubscriptionService } from '../services/subscriptionService';
import { useAuth } from '../contexts/AuthContext';
import CustomCheckout from './CustomCheckout';
import { useCurrency } from '../contexts/CurrencyContext';
import { SUBSCRIPTION_PLANS } from '../constants/currencyConfig';
import { supabase } from '../lib/supabase';

const UpgradePage: React.FC = () => {
  const [currentSubscription, setCurrentSubscription] = useState<any>(null);
  const [selectedPlan, setSelectedPlan] = useState(SUBSCRIPTION_PLANS.monthly.id);
  const [autoRenew, setAutoRenew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [showCheckout, setShowCheckout] = useState(false);
  const [error, setError] = useState('');
  const [proratedPrices, setProratedPrices] = useState<Record<string, any>>({});
  const [loadingProrated, setLoadingProrated] = useState(false);

  const { user } = useAuth();
  const navigate = useNavigate();
  const { currency, formatPrice } = useCurrency();

  const allPlans = [
    {
      ...SUBSCRIPTION_PLANS.monthly,
      planId: SUBSCRIPTION_PLANS.monthly.id,
      price: formatPrice(SUBSCRIPTION_PLANS.monthly.prices[currency] / 100),
      period: '/ month',
      description: 'Flexible monthly billing for growing businesses.',
      popular: true,
      savings: undefined,
      priceId: SUBSCRIPTION_PLANS.monthly.stripePriceIds[currency] || SUBSCRIPTION_PLANS.monthly.stripePriceIds['USD']
    },
    {
      ...SUBSCRIPTION_PLANS.semiannual,
      planId: SUBSCRIPTION_PLANS.semiannual.id,
      price: formatPrice(SUBSCRIPTION_PLANS.semiannual.prices[currency] / 100),
      period: 'one-time',
      description: 'Commit to 6 months and save 15%.',
      popular: false,
      savings: 'Save 15%',
      priceId: SUBSCRIPTION_PLANS.semiannual.stripePriceIds[currency] || SUBSCRIPTION_PLANS.semiannual.stripePriceIds['USD']
    },
    {
      ...SUBSCRIPTION_PLANS.annual,
      planId: SUBSCRIPTION_PLANS.annual.id,
      price: formatPrice(SUBSCRIPTION_PLANS.annual.prices[currency] / 100),
      period: 'one-time',
      description: 'Best value. Save 25% yearly.',
      popular: false,
      savings: 'Save 25%',
      priceId: SUBSCRIPTION_PLANS.annual.stripePriceIds[currency] || SUBSCRIPTION_PLANS.annual.stripePriceIds['USD']
    }
  ];

  const plans = allPlans.filter(p => {
    if (!currentSubscription?.subscription) return true;
    const { plan_type, status } = currentSubscription.subscription;
    if (plan_type === 'trial' || status === 'trialing') return true;
    return p.planId !== plan_type;
  });

  const currentPlan = plans.find(p => p.planId === selectedPlan) || plans[0];

  useEffect(() => {
    if (user) loadCurrentSubscription();
  }, [user]);

  useEffect(() => {
    if (currentSubscription && plans.length > 0) {
      loadProratedPrices();
    }
  }, [currentSubscription]);

  const loadCurrentSubscription = async () => {
    if (!user) return;
    try {
      const data = await SubscriptionService.checkSubscriptionAccess(user.id);
      setCurrentSubscription(data);
    } catch (error) {
      console.error('Error loading subscription:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProratedPrices = async () => {
    const { subscription } = currentSubscription;
    if (!subscription) return;
    if (subscription.plan_type === 'trial' || subscription.status === 'trialing') return;

    try {
      setLoadingProrated(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const pricesMap: Record<string, any> = {};

      for (const plan of plans) {
        try {
          const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/preview-plan-change`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              newPlanType: plan.planId,
              newPriceId: plan.priceId
            })
          });

          if (response.ok) {
            const preview = await response.json();
            pricesMap[plan.planId] = preview;
          }
        } catch (e) {
          console.error(`Error fetching prorated price for ${plan.planId}:`, e);
        }
      }

      setProratedPrices(pricesMap);
    } catch (error) {
      console.error('Error loading prorated prices:', error);
    } finally {
      setLoadingProrated(false);
    }
  };

  const formatAmount = (amount: number, currencyCode: string) => {
    const formatted = (amount / 100).toFixed(2);
    const symbol = currencyCode.toUpperCase() === 'MYR' ? 'RM' :
                   currencyCode.toUpperCase() === 'USD' ? '$' :
                   currencyCode.toUpperCase();
    return `${symbol} ${formatted}`;
  };

  const handlePaymentSuccess = async () => {
    setShowCheckout(false);
    await loadCurrentSubscription();
    window.dispatchEvent(new CustomEvent('subscription-updated'));
    navigate('/dashboard', { state: { paymentSuccess: true } });
  };

  if (loading) return (
     <div className="min-h-screen bg-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#E85A9B]" />
     </div>
  );

  if (showCheckout) {
    return (
      <CustomCheckout
        plan={currentPlan}
        priceId={currentPlan.priceId}
        autoRenew={autoRenew}
        currency={currency}
        onSuccess={handlePaymentSuccess}
        onCancel={() => setShowCheckout(false)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#FAFAFA] font-sans pb-20">
      <header className="bg-white/80 backdrop-blur-md border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/leyls-svg.svg" alt="Leyls" className="h-8 w-auto" />
          </div>
          <button
            onClick={() => navigate('/dashboard')}
            className="text-xs font-bold text-gray-400 hover:text-gray-900 uppercase tracking-widest flex items-center gap-2 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Dashboard
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-12">

        {currentSubscription && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-2xl p-6 border border-gray-100 shadow-sm mb-12 flex flex-col md:flex-row items-center justify-between gap-4"
          >
            <div className="flex items-center gap-4">
               <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#E6A85C] to-[#E85A9B] flex items-center justify-center text-white shadow-lg shadow-pink-500/20">
                  <Crown className="w-6 h-6" />
               </div>
               <div>
                 <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Current Plan</h3>
                 <p className="text-xl font-bold text-gray-900 capitalize font-['Space_Grotesk']">
                   {currentSubscription.subscription?.plan_type || 'Trial'}
                 </p>
               </div>
            </div>

            <div className="flex items-center gap-6">
               <div className="text-right">
                  <p className="text-sm font-medium text-gray-500">Status</p>
                  <p className={`font-bold ${currentSubscription.hasAccess ? 'text-green-600' : 'text-red-600'}`}>
                    {currentSubscription.hasAccess ? 'Active' : 'Expired'}
                  </p>
               </div>
               {currentSubscription.daysRemaining > 0 && (
                  <div className="text-right px-4 py-2 bg-gray-50 rounded-xl">
                    <p className="text-sm font-medium text-gray-500">Renews in</p>
                    <p className="font-bold text-gray-900">{currentSubscription.daysRemaining} days</p>
                  </div>
               )}
            </div>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-16"
        >
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4 font-['Space_Grotesk'] tracking-tight">
            Upgrade your plan
          </h1>
          <p className="text-xl text-gray-500 max-w-2xl mx-auto font-medium">
            Unlock higher limits and advanced analytics. Change anytime.
          </p>
        </motion.div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl mb-8 flex items-center gap-3">
            <AlertCircle className="h-5 w-5" />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          {plans.map((plan, index) => {
             const isSelected = selectedPlan === plan.planId;
             const prorated = proratedPrices[plan.planId];
             const showProrated = prorated && (prorated.isProrated || prorated.changeType === 'interval_change') && prorated.amount !== undefined;
             return (
              <motion.div
                key={plan.planId}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                onClick={() => setSelectedPlan(plan.planId)}
                className={`
                  relative group cursor-pointer rounded-[2rem] p-8 transition-all duration-300 flex flex-col h-full
                  ${isSelected
                    ? 'bg-white shadow-[0_20px_50px_-12px_rgba(232,90,155,0.2)] scale-[1.02] z-10 ring-2 ring-[#E85A9B] ring-offset-2 ring-offset-[#FAFAFA]'
                    : 'bg-white border border-gray-100 hover:border-gray-300 hover:shadow-xl'
                  }
                `}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-1 rounded-full text-xs font-bold tracking-wide shadow-lg">
                    MOST POPULAR
                  </div>
                )}
                {plan.savings && (
                  <div className="absolute top-6 right-6 bg-green-100 text-green-700 px-2 py-1 rounded-lg text-xs font-bold">
                    {plan.savings}
                  </div>
                )}

                <h3 className="text-xl font-bold text-gray-900 mb-2 font-['Space_Grotesk']">{plan.name}</h3>

                {loadingProrated ? (
                  <div className="flex items-center gap-2 mb-1 h-[48px]">
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                    <span className="text-sm text-gray-400">Calculating...</span>
                  </div>
                ) : showProrated ? (
                  <div className="mb-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg text-gray-400 line-through">{plan.price}</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold tracking-tight text-gray-900">
                        {prorated.changeType === 'downgrade' ? 'No charge' : formatAmount(prorated.amount, prorated.currency)}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-[#E85A9B] mt-1">
                      {prorated.changeType === 'downgrade' ? 'takes effect at period end' : 'prorated charge today'}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-4xl font-bold tracking-tight text-gray-900">{plan.price}</span>
                  </div>
                )}

                <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-6">
                  {showProrated && prorated.changeType !== 'downgrade' ? `full price: ${plan.price} ${plan.period}` : plan.period}
                </p>

                <p className="text-sm text-gray-500 mb-8 leading-relaxed flex-grow">
                  {plan.description}
                </p>

                <ul className="space-y-4 pt-6 border-t border-gray-100">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <CheckCircle className={`w-5 h-5 flex-shrink-0 ${isSelected ? 'text-[#E85A9B]' : 'text-gray-300'}`} />
                      <span className="text-sm text-gray-600 font-medium">{feature}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-gray-200 p-6 z-50 md:relative md:bg-transparent md:border-none md:backdrop-blur-none md:p-0"
        >
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 md:bg-white md:p-4 md:pl-8 md:pr-4 md:rounded-[2rem] md:shadow-2xl md:border md:border-gray-100">

             <div className="flex items-center gap-6">
                <div className="flex flex-col">
                  <span className="text-sm text-gray-500 font-medium">Selected Plan</span>
                  <span className="text-2xl font-bold text-gray-900">{currentPlan?.name}</span>
                </div>
                <div className="hidden sm:flex items-center gap-3 pl-8 border-l border-gray-100">
                   <button
                      onClick={() => setAutoRenew(!autoRenew)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        autoRenew ? 'bg-gray-900' : 'bg-gray-200'
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoRenew ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Auto-Renew</span>
                </div>
             </div>

             <button
                onClick={() => setShowCheckout(true)}
                disabled={loading || !currentPlan}
                className="w-full md:w-auto group relative inline-flex items-center justify-center px-8 py-4 text-lg font-bold text-white transition-all duration-200 shadow-xl shadow-pink-500/20 hover:shadow-pink-500/30 rounded-2xl active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-[#E6A85C] via-[#E85A9B] to-[#D946EF]" />
                <span className="relative flex items-center gap-2">
                  Proceed to Payment <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </span>
              </button>
          </div>
        </motion.div>

        <div className="text-center mt-8 pb-24 md:pb-0">
          <p className="text-xs text-gray-400 flex items-center justify-center gap-2">
            <Shield className="w-3 h-3" /> Secure payment processing powered by Stripe
          </p>
        </div>

      </div>
    </div>
  );
};

export default UpgradePage;