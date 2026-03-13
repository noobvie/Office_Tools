/* ============================================================
   Office Tools — Backend Configuration
   Update PB_URL and GRIN_SERVER_URL before deploying.
   ============================================================ */

window.OT_CONFIG = {

  /* PocketBase server URL */
  PB_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8090'
    : 'https://pb.yourdomain.com',   // ← change to your PocketBase host

  /* Grin payment Node.js server URL */
  GRIN_SERVER_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://pay.yourdomain.com',  // ← change to your payment server host

  /* Free guest usage limit per tool per day (soft, localStorage-based) */
  FREE_DAILY_LIMIT: 10,

  /* Tool IDs that require a paid Pro subscription */
  PREMIUM_TOOLS: [
    // Add future paid-only tool folder names here, e.g.:
    // 'pdf-compress', 'image-batch'
  ],

  /* Subscription plans */
  PLANS: {
    pro_monthly: { id: 'pro_monthly', name: 'Pro Monthly', grin: 10,  period: 'month', badge: '💫' },
    pro_yearly:  { id: 'pro_yearly',  name: 'Pro Yearly',  grin: 100, period: 'year',  badge: '🚀', savings: 'Save 2 months' },
    lifetime:    { id: 'lifetime',    name: 'Lifetime',    grin: 500, period: 'once',  badge: '♾️' },
  },

  /* Days before subscription expiry to show renewal reminder */
  RENEWAL_WARN_DAYS: 7,
};
