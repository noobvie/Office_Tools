/* ============================================================
   Office Tools — Backend Configuration
   Update API_SERVER_URL before deploying.
   ============================================================ */

window.OT_CONFIG = {

  /* API server URL (tools API) */
  API_SERVER_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://api.yourdomain.com',  // ← patched by deploy.sh → https://<domain>/tools-api

  /* Donation wallet address (TOR direct send) */
  GRIN_ADDRESS: 'grin16fevn3sr48j8hp863qxknvhtuxc9geg8fpvlz0v9f3fgatzu5fasvz609j',

  /* Free guest usage limit per tool per day (soft, localStorage-based) */
  FREE_DAILY_LIMIT: 10,

  /* Google Analytics 4 — OPTIONAL override only.
     The authoritative ID lives in js/common.js (OT_GA_ID), because common.js is
     the only script on every page; config.js is NOT loaded by client-only tools.
     Uncomment to override the default, or set to '' to disable analytics on the
     pages that DO load config.js. Leave commented to use the common.js default. */
  // GA_MEASUREMENT_ID: 'G-4YG2V55YEY',
};
