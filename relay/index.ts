/**
 * ByteHop Relay Server
 * 
 * Features:
 * 1. libp2p circuit relay for WebRTC signaling
 * 2. HTTP endpoints for short share codes
 */

import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import http from 'http'

const LIBP2P_PORT = process.env.LIBP2P_PORT || 9090
const HTTP_PORT = process.env.HTTP_PORT || 3001
const CODE_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

// In-memory code registry
interface CodeEntry {
    address: string
    createdAt: number
}
const codeRegistry = new Map<string, CodeEntry>()

// Generate random 6-digit code
function generateCode(): string {
    let code: string
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString()
    } while (codeRegistry.has(code))
    return code
}

// Clean expired codes periodically
setInterval(() => {
    const now = Date.now()
    for (const [code, entry] of codeRegistry) {
        if (now - entry.createdAt > CODE_EXPIRY_MS) {
            codeRegistry.delete(code)
        }
    }
}, 60000) // Check every minute

// HTTP server for code registry
function startHttpServer(): void {
    const server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)

        if (url.pathname === '/code') {
            if (req.method === 'POST') {
                // Register new code
                let body = ''
                req.on('data', chunk => body += chunk)
                req.on('end', () => {
                    try {
                        const { address } = JSON.parse(body)
                        if (!address) {
                            res.writeHead(400, { 'Content-Type': 'application/json' })
                            res.end(JSON.stringify({ error: 'Address required' }))
                            return
                        }

                        const code = generateCode()
                        codeRegistry.set(code, { address, createdAt: Date.now() })

                        console.log(`📝 Registered code ${code} → ${address.substring(0, 50)}...`)

                        res.writeHead(200, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ code }))
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ error: 'Invalid JSON' }))
                    }
                })
            } else if (req.method === 'GET') {
                // Lookup code
                const code = url.searchParams.get('code')
                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'Code required' }))
                    return
                }

                const entry = codeRegistry.get(code)
                if (!entry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'Code not found or expired' }))
                    return
                }

                // Check expiry
                if (Date.now() - entry.createdAt > CODE_EXPIRY_MS) {
                    codeRegistry.delete(code)
                    res.writeHead(404, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: 'Code expired' }))
                    return
                }

                console.log(`🔍 Looked up code ${code}`)

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ address: entry.address }))
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Method not allowed' }))
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
        }
    })

    server.listen(HTTP_PORT, () => {
        console.log(`🌐 HTTP server listening on port ${HTTP_PORT}`)
    })
}

async function main(): Promise<void> {
    console.log('🚀 Starting ByteHop relay server...')

    // Start HTTP server for codes
    startHttpServer()

    // Start libp2p relay
    const server: Libp2p = await createLibp2p({
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${LIBP2P_PORT}/ws`]
        },
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            relay: circuitRelayServer({
                reservations: {
                    maxReservations: 100,
                    reservationTtl: 60 * 60 * 1000,
                    defaultDataLimit: BigInt(1024 * 1024 * 100)
                }
            })
        }
    })

    await server.start()

    console.log('✅ Relay server started!')
    console.log('📍 Peer ID:', server.peerId.toString())
    console.log('📡 libp2p listening on:')
    server.getMultiaddrs().forEach(addr => console.log('  ', addr.toString()))

    const shutdown = async (): Promise<void> => {
        console.log('\n⏹️  Shutting down...')
        await server.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

main().catch((err: Error) => {
    console.error('Failed to start relay server:', err)
    process.exit(1)
})
