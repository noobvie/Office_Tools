/* ============================================================
   Office Tools — Backend Configuration
   Update GRIN_SERVER_URL before deploying.
   ============================================================ */

window.OT_CONFIG = {

  /* Grin server URL (donation endpoints + tools API) */
  GRIN_SERVER_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://pay.yourdomain.com',  // ← change to your server host

  /* Donation wallet address (TOR direct send) */
  GRIN_ADDRESS: 'grin16fevn3sr48j8hp863qxknvhtuxc9geg8fpvlz0v9f3fgatzu5fasvz609j',

  /* Free guest usage limit per tool per day (soft, localStorage-based) */
  FREE_DAILY_LIMIT: 10,
};
