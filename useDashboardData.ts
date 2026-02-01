import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { startOfMonth, subMonths, format, parseISO } from 'date-fns';

// --- Global Cache ---
const CACHE_DURATION = 2 * 60 * 1000; // Reduced to 2 Minutes for fresher data
const globalCache = new Map<string, { data: any; timestamp: number }>();

// --- Interfaces ---
interface DashboardStats {
  name: string;
  value: string;
  change: string;
  trend: 'up' | 'down';
  description: string;
}

interface RecentActivity {
  id: string;
  customer: string;
  avatar: string;
  action: string;
  points: string;
  time: string;
  tier: 'bronze' | 'silver' | 'gold';
  reward?: string;
}

interface CustomerGrowthData {
  date: string;
  newCustomers: number;
  returningCustomers: number;
  totalCustomers: number;
}

interface MonthlyTrendData {
  month: string;
  revenue: number;
}

export const useDashboardData = (timeRange: string = '7d') => {
  const { user, restaurant } = useAuth();
  
  // Initial State Setup
  const [stats, setStats] = useState<DashboardStats[]>([]);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [customerGrowthData, setCustomerGrowthData] = useState<CustomerGrowthData[]>([]);
  const [monthlyTrends, setMonthlyTrends] = useState<MonthlyTrendData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchDashboardData = useCallback(async (forceRefresh: boolean = false) => {
    if (!user || !restaurant) return;
    
    const cacheKey = `dashboard-${restaurant.id}-${timeRange}`;
    const cached = globalCache.get(cacheKey);
    const now = Date.now();

    // Use Cache if valid
    if (!forceRefresh && cached && (now - cached.timestamp < CACHE_DURATION)) {
      if (mountedRef.current) {
        setStats(cached.data.stats);
        setRecentActivity(cached.data.recentActivity);
        setCustomerGrowthData(cached.data.customerGrowthData);
        setMonthlyTrends(cached.data.monthlyTrends);
        setLoading(false);
      }
      return;
    }
    
    try {
      if (mountedRef.current) {
        setLoading(true);
        setError(null);
      }

      // --- 1. PARALLEL DATA FETCHING ---
      // We fetch raw tables to avoid "Relation does not exist" errors with Views
      const [
        membershipsResponse,
        transactionsResponse,
        redemptionsResponse
      ] = await Promise.all([
        // Get all members for Growth & counts
        supabase.from('memberships')
          .select('id, created_at, visit_count')
          .eq('restaurant_id', restaurant.id),
        
        // Get all transactions for Revenue & Points
        supabase.from('transactions')
          .select('*')
          .eq('restaurant_id', restaurant.id)
          .order('created_at', { ascending: false }), // Most recent first

        // Get redemptions count
        supabase.from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('restaurant_id', restaurant.id)
          .eq('type', 'redemption')
      ]);

      const members = membershipsResponse.data || [];
      const transactions = transactionsResponse.data || [];
      const totalRedemptions = redemptionsResponse.count || 0;

      // --- 2. CALCULATE HEADLINE STATS ---
      
      // Total Revenue (Sum of amount_spent)
      const totalRevenue = transactions.reduce((sum, t) => sum + (Number(t.amount_spent) || 0), 0);
      
      // Total Points Issued
      const totalPoints = transactions
        .filter(t => t.points > 0)
        .reduce((sum, t) => sum + t.points, 0);

      // New Customers This Month
      const startOfCurrentMonth = new Date();
      startOfCurrentMonth.setDate(1);
      startOfCurrentMonth.setHours(0,0,0,0);
      
      const newCustomersCount = members.filter(m => new Date(m.created_at) >= startOfCurrentMonth).length;

      const dashboardStats: DashboardStats[] = [
        {
          name: 'Total Customers',
          value: members.length.toString(),
          change: `+${newCustomersCount}`,
          trend: 'up',
          description: 'Total Active Base'
        },
        {
          name: 'Points Issued',
          value: totalPoints.toLocaleString(),
          change: '+0%',
          trend: 'up',
          description: 'Lifetime'
        },
        {
          name: 'Rewards Claimed',
          value: totalRedemptions.toString(),
          change: '+0%',
          trend: 'up',
          description: 'Total Redemptions'
        },
        {
          name: 'Total Revenue',
          value: totalRevenue.toFixed(0), // Raw number for the UI to format
          change: '+0%',
          trend: 'up',
          description: 'Gross Sales'
        }
      ];

      // --- 3. PROCESS REVENUE TRENDS (Chart) ---
      const monthsMap = new Map<string, number>();
      // Initialize last 6 months with 0
      for (let i = 5; i >= 0; i--) {
        const d = subMonths(new Date(), i);
        monthsMap.set(format(d, 'MMM'), 0);
      }

      transactions.forEach(t => {
        const date = new Date(t.created_at);
        // Only count transactions from the last 6 months
        if (date >= subMonths(new Date(), 6)) {
          const key = format(date, 'MMM');
          if (monthsMap.has(key)) {
            monthsMap.set(key, monthsMap.get(key)! + (Number(t.amount_spent) || 0));
          }
        }
      });

      const trendsData: MonthlyTrendData[] = Array.from(monthsMap.entries()).map(([month, revenue]) => ({
        month,
        revenue,
        loyaltyRevenue: 0, 
        rewardCosts: 0,
        netProfit: 0
      }));

      // --- 4. PROCESS CUSTOMER GROWTH (Chart) ---
      const growthMap = new Map<string, { new: number; returning: number }>();
      const growthDays = timeRange === '30d' ? 30 : 7;
      
      // Initialize days
      for (let i = growthDays - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        growthMap.set(format(d, 'MMM d'), { new: 0, returning: 0 });
      }

      members.forEach(m => {
        const dateKey = format(new Date(m.created_at), 'MMM d');
        if (growthMap.has(dateKey)) {
          const curr = growthMap.get(dateKey)!;
          curr.new += 1;
          if (m.visit_count > 1) curr.returning += 1; // Rough estimate based on visit count
        }
      });

      const growthData: CustomerGrowthData[] = Array.from(growthMap.entries()).map(([date, counts]) => ({
        date,
        newCustomers: counts.new,
        returningCustomers: counts.returning,
        totalCustomers: 0
      }));

      // --- 5. PROCESS RECENT ACTIVITY (Feed) ---
      // We manually fetch profiles to avoid Join errors
      const uniqueUserIds = [...new Set(transactions.slice(0, 10).map(t => t.customer_id))];
      
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, avatar_url')
        .in('id', uniqueUserIds);

      const profilesMap = new Map(profiles?.map(p => [p.id, p]));

      const activityData: RecentActivity[] = transactions.slice(0, 5).map(t => {
        const profile = profilesMap.get(t.customer_id);
        const name = profile ? `${profile.first_name || 'Guest'} ${profile.last_name || ''}` : 'Unknown Customer';
        
        return {
          id: t.id,
          customer: name,
          avatar: (profile?.first_name || 'U')[0].toUpperCase(),
          action: t.type === 'redemption' ? 'Redeemed Reward' : (t.description || 'Order'),
          points: t.points > 0 ? `+${t.points}` : `${t.points}`,
          time: new Date(t.created_at).toLocaleDateString(),
          tier: 'bronze' // You can map this from memberships if needed
        };
      });

      // --- 6. UPDATE STATE ---
      if (mountedRef.current) {
        setStats(dashboardStats);
        setCustomerGrowthData(growthData);
        setMonthlyTrends(trendsData);
        setRecentActivity(activityData);
        
        // Cache the result
        globalCache.set(cacheKey, {
          timestamp: Date.now(),
          data: {
            stats: dashboardStats,
            recentActivity: activityData,
            customerGrowthData: growthData,
            monthlyTrends: trendsData,
          }
        });
      }

    } catch (err: any) {
      console.error('Error fetching dashboard data:', err);
      if (mountedRef.current) setError('Failed to refresh dashboard.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [restaurant, timeRange, user]);

  const refreshData = useCallback(() => {
    fetchDashboardData(true);
  }, [fetchDashboardData]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  return {
    stats,
    recentActivity,
    customerGrowthData,
    monthlyTrends,
    loading,
    error,
    refreshData
  };
};