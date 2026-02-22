# ByteHop

**Browser-to-browser P2P file sharing** — no server uploads, no file size limits, no accounts.

ByteHop lets two browsers exchange files directly using WebRTC, with a lightweight relay server for connection setup only. Files never touch a server.

## How It Works

### Connection Flow

```
  Browser A                    Relay Server                   Browser B
  ─────────                    ────────────                   ─────────
      │                             │                              │
      ├── WebSocket connect ───────►│                              │
      │◄── circuit relay reserved ──┤                              │
      │                             │                              │
      ├── POST /code ──────────────►│  (stores address → 847291)   │
      │◄── { code: "847291" } ──────┤                              │
      │                             │                              │
      │        User shares code "847291" out-of-band               │
      │                             │                              │
      │                             │◄── GET /code?code=847291 ────┤
      │                             ├── { address: "..." } ───────►│
      │                             │                              │
      │◄─────── WebRTC signaling via circuit relay ───────────────►│
      │                             │                              │
      │◄══════════ Direct WebRTC data channel (P2P) ══════════════►│
      │           File data flows directly, not via server         │
```

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Nuxt 4 Frontend                      │
│  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │   useLibp2p.ts   │  │    useFileTransfer.ts        │  │
│  │                  │  │                             │  │
│  │  • Node init     │  │  • Chunked file streaming   │  │
│  │  • Relay connect │  │  • OPFS storage             │  │
│  │  • Share codes   │  │  • Progress tracking        │  │
│  │  • Peer connect  │  │  • Session cleanup          │  │
│  └──────────────────┘  └─────────────────────────────┘  │
│                                                         │
│  Transports: WebSocket → Circuit Relay → WebRTC         │
│  Encryption: Noise protocol                             │
│  Muxing: Yamux                                          │
└─────────────────────────────────────────────────────────┘
          │ WSS                              │ HTTPS
          ▼                                  ▼
┌───────────────────────┐     ┌──────────────────────────┐
│   libp2p Relay Server │     │   HTTP Code Registry     │
│   (port 9090)         │     │   (port 3001)            │
│                       │     │                          │
│   • Circuit relay v2  │     │   • POST /code → 6-digit │
│   • WebSocket listen  │     │   • GET /code?code=...   │
│   • 100 reservations  │     │   • 5-min expiry         │
└───────────────────────┘     └──────────────────────────┘
          └──────── relay/index.ts ────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Nuxt 4, Vue 3, Nuxt UI |
| **P2P Networking** | libp2p (WebRTC + WebSocket + Circuit Relay v2) |
| **Encryption** | Noise protocol (end-to-end) |
| **Stream Muxing** | Yamux |
| **File Storage** | OPFS (Origin Private File System) |
| **Relay Server** | Node.js + libp2p + HTTP |
| **Process Manager** | PM2 |
| **Reverse Proxy** | Nginx |

## Project Structure

```
bytehop/
├── app/
│   ├── composables/
│   │   ├── useLibp2p.ts          # P2P node, relay, share codes
│   │   └── useFileTransfer.ts    # File chunking, streaming, OPFS
│   ├── pages/
│   │   └── index.vue             # Main UI
│   └── app.vue                   # Root layout
├── relay/
│   └── index.ts                  # Relay server + code registry
├── public/
│   └── cleanup-sw.js             # Service worker for OPFS cleanup
├── ecosystem.config.cjs          # PM2 process config
├── nuxt.config.ts                # Nuxt + Vite config
└── package.json
```

## Implementation Details

### P2P Connection (`useLibp2p.ts`)

The browser creates a libp2p node with three transport layers:

1. **WebSocket** — connects to the relay server
2. **Circuit Relay v2** — gets a routable address through the relay
3. **WebRTC** — establishes a direct peer-to-peer connection

```
WebSocket → Relay → Circuit Relay Address → WebRTC Direct Connection
```

Once two peers have a WebRTC connection, all data flows directly between browsers — the relay is no longer involved.

### Share Codes

Instead of sharing long multiaddrs, peers use 6-digit codes:

1. **Sender** calls `POST /code` with their circuit relay address → gets back `847291`
2. **Receiver** calls `GET /code?code=847291` → gets the sender's address
3. Receiver dials the address and WebRTC negotiation begins
4. Codes expire after 5 minutes

### File Transfer (`useFileTransfer.ts`)

Files are sent using a custom protocol (`/bytehop/file/1.0.0`):

1. **Metadata first** — filename and size are sent as a JSON header
2. **Chunked streaming** — file data is read and sent in 64KB chunks via `byteStream`
3. **OPFS storage** — received chunks are written to the Origin Private File System
4. **Progress tracking** — real-time progress updates for both sender and receiver

### OPFS Cleanup

Received files are stored temporarily in OPFS. Cleanup happens via:

- **On startup** — removes any leftover `bytehop-*` files from previous sessions
- **Service worker** — monitors for all tabs closing and cleans up (trusted HTTPS only)

## Development

### Prerequisites

- Node.js 22+
- npm or bun

### Run locally

```bash
# Terminal 1: Start relay server
npm run dev:relay

# Terminal 2: Start Nuxt dev server
npm run dev
```

Open `http://localhost:3000` in two tabs to test file sharing.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_ADDRESS` | `/ip4/127.0.0.1/tcp/9090/ws` | libp2p relay multiaddr |
| `CODE_API_URL` | `http://localhost:3001` | Code registry HTTP endpoint |

### Lint & Type Check

```bash
npm run lint        # ESLint
npm run lint:fix    # Auto-fix
npm run typecheck   # TypeScript
```

## Production Deployment

ByteHop deploys with **PM2** behind **Nginx** with SSL.

```bash
# Build with production URLs
RELAY_ADDRESS="/dns4/yourdomain.com/tcp/443/tls/ws" \
CODE_API_URL="https://yourdomain.com/api" \
npm run build

# Start processes
pm2 start ecosystem.config.cjs
```

Nginx routes traffic on port 443:
- Regular HTTP → Nuxt frontend (port 3000)
- WebSocket upgrades → libp2p relay (port 9090)
- `/api/` → Code registry (port 3001)

See the deployment guide for full setup with Alpine Linux, SSL, and auto-renewal.

## Security

- **End-to-end encryption** — Noise protocol encrypts all libp2p streams
- **No server storage** — files transfer directly between browsers
- **Ephemeral codes** — share codes expire after 5 minutes
- **Session cleanup** — OPFS files are cleaned up when all tabs close
- **No accounts** — no registration, no tracking

## License

MIT
