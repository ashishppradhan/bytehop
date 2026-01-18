/**
 * libp2p Relay Server
 * 
 * This server enables browser-to-browser P2P connections by:
 * 1. Providing a WebSocket endpoint browsers can connect to
 * 2. Running circuit relay v2 for signaling between browsers
 * 3. Acting as fallback relay when direct connections fail
 */

import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { all } from '@libp2p/websockets/filters'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'

const PORT = process.env.PORT || 9090

async function main(): Promise<void> {
    console.log('🚀 Starting libp2p relay server...')

    const server: Libp2p = await createLibp2p({
        addresses: {
            listen: [
                `/ip4/0.0.0.0/tcp/${PORT}/ws`
            ]
        },
        transports: [
            webSockets({
                filter: all // Accept all connections
            })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            relay: circuitRelayServer({
                reservations: {
                    maxReservations: 100,
                    reservationTtl: 60 * 60 * 1000, // 1 hour
                    defaultDataLimit: BigInt(1024 * 1024 * 100) // 100MB per reservation
                }
            })
        }
    })

    await server.start()

    console.log('✅ Relay server started!')
    console.log('📍 Peer ID:', server.peerId.toString())
    console.log('📡 Listening on:')

    server.getMultiaddrs().forEach(addr => {
        console.log('  ', addr.toString())
    })

    console.log('\n💡 Browsers can connect using these addresses')

    // Handle graceful shutdown
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
