'use strict';

// The visitor's IP address, and the key every per-IP limit counts against.
//
// Trust model: nginx sets `X-Real-IP: $remote_addr` on every proxied request, and
// its real_ip config (Cloudflare ranges only) makes $remote_addr the true visitor.
// So X-Real-IP is believed ONLY when the TCP peer is loopback — i.e. the request
// really came through the local nginx. A request that reaches this port directly
// gets its socket address, whatever headers it sends. X-Forwarded-For and
// CF-Connecting-IP are never read: both are client-controlled at some hop.
//
//   clientIp(req)  → '203.0.113.7' / '2001:db8::1'  (works for a WebSocket upgrade req too)
//   rateKey(ip)    → IPv4 unchanged, IPv6 → its /64 ('2001:db8:0:0::/64')
//
// rateKey exists because one IPv6 subscriber normally holds a whole /64: keying a
// limiter on the full address would hand each visitor 2^64 fresh buckets. Keep the
// FULL address wherever the address itself is the product (the /ip echo, the stored
// feedback IP, File Drop's same-network grouping).

const net = require('net');

function stripMapped(ip) {
  const s = String(ip || '');
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s) ? s.slice(7) : s;
}

function isLoopback(ip) {
  const s = stripMapped(ip);
  if (net.isIPv4(s)) return s.startsWith('127.');
  return s === '::1';
}

function clientIp(req) {
  const peer = req?.socket?.remoteAddress || '';
  if (isLoopback(peer)) {
    const h = req.headers?.['x-real-ip'];
    const v = typeof h === 'string' ? h.trim() : '';
    if (v && net.isIP(v)) return stripMapped(v);
  }
  return stripMapped(peer);
}

// Expand an IPv6 address into its 8 hextets (no zone id). null if not IPv6.
function ipv6Hextets(ip) {
  let s = String(ip || '').split('%')[0];
  if (!net.isIPv6(s)) return null;
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two hextets.
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const o = m[2].split('.').map(Number);
    s = m[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...t];
  return all.length === 8 ? all.map(x => parseInt(x, 16)) : null;
}

function rateKey(ip) {
  const s = stripMapped(ip);
  if (net.isIPv4(s)) return s;
  const h = ipv6Hextets(s);
  if (!h) return s || 'unknown';
  return h.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}

module.exports = { clientIp, rateKey, isLoopback };
