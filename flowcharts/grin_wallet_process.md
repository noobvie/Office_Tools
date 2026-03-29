# Office Tools — Grin Wallet Process

## Why three donation methods?

- **Method 1 — TOR Direct**: simplest, but requires TOR to be running on the user's machine. Not all users have it.
- **Method 2 — Slatepack (You Send)**: no TOR needed. User generates a slate from their wallet CLI, pastes it into the page.
- **Method 3 — Invoice (We Request)**: no TOR needed. We generate the invoice, user pays from their wallet CLI.

Methods 2 and 3 exist specifically for users without TOR.

---

## Server processes

```
┌─────────────────────────────────────────────────────────────────┐
│  SERVER PROCESSES                                               │
│                                                                 │
│  tmux: donate_grin_tor          tmux: donate_grin_slatepack    │
│  ┌──────────────────────┐       ┌──────────────────────────┐   │
│  │ grin-wallet listen   │       │ grin-wallet owner_api    │   │
│  │                      │       │                          │   │
│  │ Foreign API :3415    │       │ Owner API :3420          │   │
│  │ /v2/foreign          │       │ /v3/owner (encrypted)    │   │
│  │                      │       │                          │   │
│  │ Auth: wallet_data/   │       │ Auth: .owner_api_secret  │   │
│  │       .api_secret    │       │                          │   │
│  └──────────┬───────────┘       └───────────┬──────────────┘   │
│             │                               │                  │
│             └──────────────┬────────────────┘                  │
│                            │ both share same wallet_data/      │
│                            │ no file-lock conflict —           │
│                            │ APIs run inside the existing lock │
└────────────────────────────┼────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────────┐
              │  Node.js :3001                  │
              │  grin-payment-server.js          │
              │                                 │
              │  /api/donate/receive             │
              │    1. Owner: slate_from_slatepack│──→ :3420/v3/owner
              │    2. Foreign: receive_tx        │──→ :3415/v2/foreign
              │    3. Owner: create_slatepack    │──→ :3420/v3/owner
              │                                 │
              │  /api/donate/invoice             │
              │    1. Owner: issue_invoice_tx    │──→ :3420/v3/owner
              │    2. Owner: create_slatepack    │──→ :3420/v3/owner
              │                                 │
              │  /api/donate/finalize            │
              │    1. Owner: slate_from_slatepack│──→ :3420/v3/owner
              │    2. Owner: finalize_tx         │──→ :3420/v3/owner
              │                                 │
              │  /api/wallet/status              │
              │    TCP probe :3415               │──→ donate_grin_tor up?
              └──────────────┬──────────────────┘
                             │ nginx /pay-api/*
                             ▼
                       Browser (donate.html)
                         Method 1: TOR Direct ──────────────────→ :3415 (bypasses Node.js)
                         Method 2: Slatepack  ──→ /api/donate/receive
                         Method 3: Invoice    ──→ /api/donate/invoice + finalize
```

---

## Per-method flow

### Method 1 — TOR Direct (donate_grin_tor required)

```
User wallet (TOR) ──────────────────────────────→ :3415 Foreign API
                                                   grin-wallet listen
                                                   (no Node.js involved)
```

### Method 2 — Slatepack / You Send (both sessions required)

```
1. User runs:  grin-wallet send -d <our_address> <amount>
               → wallet outputs a send slatepack

2. User pastes slatepack into donate.html
   Browser → POST /api/donate/receive { slatepack }
               Node.js:
                 a. Owner API  slate_from_slatepack_message → slate JSON
                 b. Foreign API receive_tx(slate)           → response slate JSON
                 c. Owner API  create_slatepack_message     → response slatepack

3. Page shows response slatepack
   User runs:  grin-wallet finalize -i response.slatepack
               → broadcasts the transaction
```

### Method 3 — Invoice / We Request (both sessions required)

```
Step 1 — Create invoice:
   User enters amount + their wallet address → POST /api/donate/invoice
               Node.js:
                 a. Owner API  issue_invoice_tx(amount, address) → invoice slate JSON
                 b. Owner API  create_slatepack_message          → invoice slatepack
   Page shows invoice slatepack

Step 2 — User pays:
   User runs:  grin-wallet pay -i invoice.slatepack
               → wallet outputs a payment slatepack

Step 3 — Finalize:
   User pastes payment slatepack → POST /api/donate/finalize
               Node.js:
                 a. Owner API  slate_from_slatepack_message → slate JSON
                 b. Owner API  finalize_tx(slate)           → broadcast
   Page shows success
```

---

## Owner API encryption (init_secure_api)

Every Owner API call goes through this flow — fresh session per HTTP request:

```
Node.js                                    grin-wallet :3420/v3/owner
   │
   │  1. Generate secp256k1 ECDH keypair (crypto.createECDH)
   │  POST init_secure_api { ecdh_pubkey: ourCompressedHex }
   │ ──────────────────────────────────────────────────────→
   │ ←────────────────────────────────────────────────────
   │  { result: { Ok: serverCompressedHex } }
   │
   │  2. Compute shared secret (ECDH x-coordinate, 32 bytes)
   │
   │  3. POST encrypted open_wallet
   │     body_enc = base64( AES-256-GCM(inner_json) + auth_tag )
   │     nonce    = random 12 bytes (also used as JSON-RPC id)
   │ ──────────────────────────────────────────────────────→
   │ ←────────────────────────────────────────────────────
   │  { result: { Ok: { body_enc, nonce } } }  (encrypted)
   │  → decrypt → wallet token
   │
   │  4. POST encrypted <method> { token, ...params }
   │ ──────────────────────────────────────────────────────→
   │ ←────────────────────────────────────────────────────
   │  → decrypt → result
```

---

## Secret files

```
/opt/office-tools/cmdgrinwallet/
  ├── wallet_data/
  │   └── .api_secret          ← Foreign API Basic Auth (auto-created by grin-wallet)
  └── .owner_api_secret        ← Owner API Basic Auth  (auto-created by grin-wallet)

/opt/office-tools/backend/.env
  ├── GRIN_API_SECRET_FILE=/opt/office-tools/cmdgrinwallet/wallet_data/.api_secret
  └── GRIN_OWNER_API_SECRET_FILE=/opt/office-tools/cmdgrinwallet/.owner_api_secret
```

Both secret files are created and owned by grin-wallet. The `.env` only stores the paths — the secrets never leave their original files.

---

## Wallet status badge logic

```
donate.html polls every 30s:
  GET /api/wallet/status
    → Node.js TCP probe 127.0.0.1:3415 (3s timeout)
    → reachable   : 200 { status: 'ok' }    → green  "Wallet online"
    → unreachable : 503 { status: 'error' } → red    "Wallet offline"

Note: badge only reflects donate_grin_tor (port 3415).
      donate_grin_slatepack (port 3420) has no separate badge —
      if it is down, Methods 2 and 3 will return an error message.
```

---

## Session management (deploy_grinwallet.sh option 2)

| # | Action |
|---|--------|
| 1 | Start TOR listener  (`donate_grin_tor`) |
| 2 | Stop TOR listener |
| 3 | Restart TOR listener |
| 4 | View wallet log |
| 5 | Start Owner API  (`donate_grin_slatepack`) |
| 6 | Stop Owner API |
| 7 | Restart Owner API |
| 8 | Re-save passphrase |
| 9 | Enable auto-start on reboot (both sessions) |
| 10 | Disable auto-start on reboot |
| 11 | Enable watchdog cron (port 3415, every 30 min) |
| 12 | Disable watchdog |
| 13 | View watchdog log |

To view live tmux output, run **outside this script**:
```bash
tmux attach -t donate_grin_tor        # TOR listener
tmux attach -t donate_grin_slatepack  # Owner API
```
