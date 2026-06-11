# DNS Leak Test — Infrastructure Design (decision doc)

**Status:** proposal / not built. The client-side **VPN / IP Leak Test**
(`tools/vpn-leak-test/`) already covers public-IP, WebRTC and IPv6 leaks with
**zero new infrastructure**. A *true* DNS leak test cannot be done client-side —
this doc lays out what it would take so we can decide whether it's worth it.

---

## Why DNS leak detection can't be browser-only

A DNS leak is when your **DNS resolver** (not your IP) is your ISP's instead of
your VPN's. The browser never sees which resolver it used — only the OS/VPN does.
The only way to observe it is to **watch, from the authoritative side, which
resolver IP asks for a name we control**. That requires running our own
authoritative DNS server. No JavaScript API exposes the resolver.

```
The trick every dnsleaktest-style site uses:

  1. Page asks the browser to resolve N unique random hostnames:
        a1b2c3.<testid>.dnstest.grin.money
        d4e5f6.<testid>.dnstest.grin.money   ...
  2. Each lookup travels OS → configured resolver → ... → OUR authoritative NS
  3. OUR NS logs (testid, resolver_source_ip) for every query it answers
  4. Page polls our API: "which resolvers asked about <testid>?"
  5. Compare those resolver IPs/ASNs to the user's VPN exit IP/ASN.
        resolver ASN == ISP, not VPN  →  DNS LEAK
```

---

## Components required

```
                         ┌─────────────────────────────────────────┐
   Browser               │            grin.money infra              │
  (tool page)            │                                          │
     │                   │   ┌────────────────────────────────┐     │
     │ 1. GET testid     │   │  Express :3001 (existing)        │     │
     ├──────────────────────▶│  POST /api/dnsleak/new → testid │     │
     │                   │   │  GET  /api/dnsleak/:id  → results│     │
     │                   │   └──────────────┬─────────────────┘     │
     │ 2. trigger lookups│                  │ read                   │
     │   fetch/img to    │                  ▼                        │
     │   <rand>.<id>.    │   ┌────────────────────────────────┐     │
     │   dnstest.grin... │   │  shared store (SQLite/Redis)     │     │
     │                   │   │  (testid, resolver_ip, ts)       │     │
     │                   │   └──────────────▲─────────────────┘     │
     │                   │                  │ write                  │
     │   3. DNS query    │   ┌──────────────┴─────────────────┐     │
     │   path (UDP 53)   │   │  Authoritative DNS daemon :53    │     │
     └───────────────────────▶│  zone: dnstest.grin.money       │     │
       (via user's resolver)  │  • answers wildcard *.<id>...    │     │
                          │   │  • logs source resolver IP       │     │
                          │   └──────────────────────────────────┘     │
                          └─────────────────────────────────────────┘
```

1. **Authoritative DNS daemon** on the VPS, bound to **UDP/TCP 53**, authoritative
   for a delegated zone (e.g. `dnstest.grin.money`). On each query it (a) answers
   with a wildcard A/AAAA record and (b) writes `(testid, resolver_src_ip, ts)` to
   the shared store. ~150 lines of Go (`miekg/dns`) or Node (`dns2`/`native-dns`).
2. **Shared store** keyed by `testid` — SQLite is fine (low volume), Redis if we
   want TTL eviction for free. The DNS daemon writes; Express reads.
3. **Express endpoints** (added to `office-tools-server.js`):
   - `POST /api/dnsleak/new` → returns a random `testid` (+ how many subdomains to hit)
   - `GET  /api/dnsleak/:id` → returns the distinct resolver IPs seen for that id,
     enriched with geo/ASN (reuse the existing `/api/ip/geo` path)
4. **Frontend** triggers the lookups by requesting unique hostnames
   (`fetch()`/`new Image()` to `https://<rand>.<id>.dnstest.grin.money/x.gif`),
   waits ~2–3 s, then polls `GET /api/dnsleak/:id` and compares resolver ASN to the
   user's VPN exit ASN (already detected by the existing leak-test tool).

---

## The Cloudflare wrinkle (important)

`grin.money` is proxied through Cloudflare. The DNS test zone **must NOT be**:

- **Proxied (orange cloud)** — then Cloudflare's resolver answers and we'd only ever
  see Cloudflare, never the user's resolver. Useless.
- Even **DNS-only (grey cloud) on a normal A record is not enough** — Cloudflare is
  still the *authoritative* nameserver for `grin.money`, so it answers and logs
  nothing for us.

What's required: **delegate a subdomain's NS to our own server.** At the
`grin.money` zone, add:

```
dnstest   NS   ns-dnstest.grin.money.
ns-dnstest A    <VPS_public_ip>     ; DNS-only (grey cloud)
```

Now every query for `*.dnstest.grin.money` is sent by the user's resolver
**directly to our VPS:53**, bypassing Cloudflare entirely. The `ns-dnstest` glue
record must be unproxied. The HTTP side (the `.gif` the browser fetches) can still
ride normal Cloudflare HTTPS — only the **DNS** must bypass it.

---

## Operational considerations

- **Port 53 must be free** on the VPS (no `systemd-resolved`/`bind` already bound).
  Firewall must allow inbound UDP+TCP 53. The box becomes a public authoritative NS
  for one zone — it will receive background internet noise/scans on 53.
- **Abuse / load:** this is a network-probe service. Rate-limit `POST /api/dnsleak/new`
  per IP (reuse the existing rate-limit middleware pattern). Cap subdomains per test
  (~10). Evict store rows after a few minutes (TTL) — we only need them for the
  polling window.
- **No PII stored long-term:** resolver IPs are transient; purge on a short timer.
- **IPv6:** to also catch IPv6-resolver leaks, the NS needs an AAAA glue + the VPS
  needs inbound IPv6:53.

---

## Effort & decision

| Piece | Effort | Notes |
|---|---|---|
| Authoritative DNS daemon + logging | **M** | ~150 LOC Go/Node; the only genuinely new moving part |
| NS delegation + glue (Cloudflare) | **S** | one-time DNS change; must be DNS-only |
| Express endpoints + store + rate-limit | **S** | mirrors existing `/api/ip/*` + rate-limit patterns |
| Frontend tab (fold into vpn-leak-test) | **S** | trigger lookups, poll, compare ASN |
| systemd unit + firewall (deploy.sh) | **S** | run daemon as a service; open UDP/TCP 53 |

**Net:** one new long-running service (DNS daemon on :53) + one DNS delegation +
a few endpoints. Everything else reuses existing patterns.

**Recommendation:** ship the client-side VPN/IP leak test now (done). Build the DNS
leak test **only if** we're willing to (a) run an authoritative nameserver on the
VPS and (b) delegate `dnstest.grin.money` outside Cloudflare. If yes, the natural
home is a **second tab inside `tools/vpn-leak-test/`** so users get all four leak
checks (IP, WebRTC, IPv6, DNS) in one place.
