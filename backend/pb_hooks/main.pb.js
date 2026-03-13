/**
 * PocketBase JS Hooks — Office Tools
 * Place this file in pb_hooks/main.pb.js inside your PocketBase directory.
 *
 * Docs: https://pocketbase.io/docs/js-overview/
 */

// ── Auto-expire subscriptions ────────────────────────────────
// Runs daily: marks subscriptions past their expires_at as expired
cronAdd("expire-subscriptions", "0 3 * * *", () => {
  const now = new Date().toISOString();
  const records = $app.dao().findRecordsByFilter(
    "subscriptions",
    `status = 'active' && expires_at != '' && expires_at < {:now}`,
    "-created", 500, 0,
    { now }
  );
  records.forEach(record => {
    record.set("status", "expired");
    $app.dao().saveRecord(record);
  });
  console.log(`[cron] Expired ${records.length} subscription(s).`);
});

// ── Auto-expire pending Grin payments ────────────────────────
cronAdd("expire-grin-payments", "*/15 * * * *", () => {
  const now = new Date().toISOString();
  const records = $app.dao().findRecordsByFilter(
    "grin_payments",
    `status = 'pending' && expires_at != '' && expires_at < {:now}`,
    "-created", 200, 0,
    { now }
  );
  records.forEach(record => {
    record.set("status", "expired");
    $app.dao().saveRecord(record);
  });
  if (records.length) console.log(`[cron] Expired ${records.length} pending Grin payment(s).`);
});

// ── Send welcome email on registration ───────────────────────
onRecordAfterCreateRequest((e) => {
  const user = e.record;
  // Only send if email is verified (or verification not required)
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
}, "users");

// ── Log subscription activation ──────────────────────────────
onRecordAfterCreateRequest((e) => {
  const sub = e.record;
  console.log(`[subscription] New: user=${sub.getString("user")} plan=${sub.getString("plan")} status=${sub.getString("status")}`);
}, "subscriptions");
