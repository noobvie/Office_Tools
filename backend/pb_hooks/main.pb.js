/**
 * PocketBase JS Hooks — Office Tools
 * Compatible with PocketBase v0.23+
 *
 * API changes from v0.23:
 *   onRecordAfterCreateRequest  → onRecordAfterCreateSuccess
 *   $app.dao().findRecordsByFilter() → $app.findRecordsByFilter()
 *   $app.dao().saveRecord()     → $app.save()
 *
 * Docs: https://pocketbase.io/docs/js-overview/
 */

// ── Auto-create required collections ─────────────────────────
// Collections are created by the Node.js payment server on startup
// (grin-payment-server.js → initCollections()).
// Keeping this file clean of top-level $app calls to avoid
// nil-pointer panics during PocketBase's boot sequence.

// ── Auto-expire subscriptions ────────────────────────────────
// Runs daily at 03:00: marks subscriptions past their expires_at as expired
cronAdd("expire-subscriptions", "0 3 * * *", () => {
  const now = new Date().toISOString();
  const records = $app.findRecordsByFilter(
    "subscriptions",
    `status = 'active' && expires_at != '' && expires_at < {:now}`,
    "-created", 500, 0,
    { now }
  );
  records.forEach(record => {
    record.set("status", "expired");
    $app.save(record);
  });
  console.log(`[cron] Expired ${records.length} subscription(s).`);
});

// ── Auto-expire pending Grin payments ────────────────────────
// Runs every 15 min: marks pending payments past their expires_at as expired
cronAdd("expire-grin-payments", "*/15 * * * *", () => {
  const now = new Date().toISOString();
  const records = $app.findRecordsByFilter(
    "grin_payments",
    `status = 'pending' && expires_at != '' && expires_at < {:now}`,
    "-created", 200, 0,
    { now }
  );
  records.forEach(record => {
    record.set("status", "expired");
    $app.save(record);
  });
  if (records.length) console.log(`[cron] Expired ${records.length} pending Grin payment(s).`);
});

// ── Send welcome email on registration ───────────────────────
onRecordAfterCreateSuccess((e) => {
  const user = e.record;
  try {
    $app.newMailClient().send({
      from: { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName },
      to:   [{ address: user.email() }],
      subject: "Welcome to Office Tools!",
      html: `
        <h2>Welcome to Office Tools 🛠️</h2>
        <p>Hi ${user.getString("name") || "there"},</p>
        <p>Your account is ready. You now have unlimited access to all 28 free tools.</p>
        <p><a href="${$app.settings().meta.appUrl}/auth/dashboard.html" style="background:#6366f1;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Open Dashboard →</a></p>
        <p style="color:#666;font-size:12px;margin-top:24px">Office Tools — Free browser-based utilities for everyday work.</p>
      `,
    });
  } catch (err) {
    console.log(`[welcome-email] Failed to send to ${user.email()}: ${err}`);
  }
}, "users");

// ── Log subscription activation ──────────────────────────────
onRecordAfterCreateSuccess((e) => {
  const sub = e.record;
  console.log(`[subscription] New: user=${sub.getString("user")} plan=${sub.getString("plan")} status=${sub.getString("status")}`);
}, "subscriptions");

// ── Purge expired short URLs (daily at 04:00) ────────────────
cronAdd("purge-short-urls", "0 4 * * *", () => {
  const now = new Date().toISOString();
  const records = $app.findRecordsByFilter(
    "short_urls",
    `expires != '' && expires < {:now}`,
    "-created", 500, 0,
    { now }
  );
  records.forEach(r => $app.delete(r));
  if (records.length) console.log(`[cron] Deleted ${records.length} expired short URL(s).`);
});

// ── Purge expired pastes (daily at 04:05) ────────────────────
cronAdd("purge-pastes", "5 4 * * *", () => {
  const now = new Date().toISOString();
  const records = $app.findRecordsByFilter(
    "pastes",
    `expires != '' && expires < {:now}`,
    "-created", 500, 0,
    { now }
  );
  records.forEach(r => $app.delete(r));
  if (records.length) console.log(`[cron] Deleted ${records.length} expired paste(s).`);
});

// ── Purge expired file shares (daily at 04:10) ───────────────
cronAdd("purge-file-shares", "10 4 * * *", () => {
  const now = new Date().toISOString();
  const records = $app.findRecordsByFilter(
    "file_shares",
    `expires != '' && expires < {:now}`,
    "-created", 200, 0,
    { now }
  );
  records.forEach(r => $app.delete(r));
  if (records.length) console.log(`[cron] Deleted ${records.length} expired file share(s).`);
});
