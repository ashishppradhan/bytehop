/**
 * LibP2P composable for P2P file sharing
 * 
 * Uses WebRTC for browser-to-browser connections via circuit relay
 */

import { createLibp2p, type Libp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify, identifyPush, type Identify, type IdentifyPush } from '@libp2p/identify'
import { ping, type Ping } from '@libp2p/ping'

// Define the services type for our libp2p node
interface LibP2PServices {
    identify: Identify
    identifyPush: IdentifyPush
    ping: Ping
    [key: string]: unknown
}

type LibP2PNode = Libp2p<LibP2PServices>
import { multiaddr } from '@multiformats/multiaddr'
import { WebRTC } from '@multiformats/multiaddr-matcher'

export interface LibP2PState {
    node: LibP2PNode | null
    peerId: string | null
    isConnected: boolean
    relayConnected: boolean
    relayPeerId: string | null
    connectedPeers: string[]
    webrtcAddress: string | null
    error: string | null
}

export function useLibp2p() {
    const config = useRuntimeConfig()

    const state = reactive<LibP2PState>({
        node: null,
        peerId: null,
        isConnected: false,
        relayConnected: false,
        relayPeerId: null,
        connectedPeers: [],
        webrtcAddress: null,
        error: null
    })

    // Initialize libp2p node
    async function initNode(): Promise<void> {
        if (state.node) return

        try {
            const node = await createLibp2p({
                addresses: {
                    listen: ['/p2p-circuit', '/webrtc']
                },
                transports: [
                    webSockets(),
                    webRTC({
                        rtcConfiguration: {
                            iceServers: [
                                { urls: ['stun:stun.l.google.com:19302'] },
                                { urls: ['stun:stun1.l.google.com:19302'] }
                            ]
                        }
                    }),
                    circuitRelayTransport({ reservationCompletionTimeout: 30000 })
                ],
                connectionEncrypters: [noise()],
                streamMuxers: [yamux()],
                connectionGater: {
                    denyDialMultiaddr: () => false
                },
                services: {
                    identify: identify(),
                    identifyPush: identifyPush(),
                    ping: ping()
                }
            })

            await node.start()

            // Event handlers
            node.addEventListener('connection:open', (event) => {
                const peerId = event.detail.remotePeer.toString()

                // Don't add relay to connected peers
                if (peerId !== state.relayPeerId && !state.connectedPeers.includes(peerId)) {
                    state.connectedPeers.push(peerId)
                }

                updateWebRTCAddress()
            })

            node.addEventListener('connection:close', (event) => {
                const peerId = event.detail.remotePeer.toString()
                state.connectedPeers = state.connectedPeers.filter(p => p !== peerId)
            })

            node.addEventListener('self:peer:update', () => {
                updateWebRTCAddress()
            })

            state.node = node
            state.peerId = node.peerId.toString()
            state.isConnected = true

            console.log('✅ Node started:', state.peerId)

            // Connect to relay
            await connectToRelay()

        } catch (err) {
            console.error('Failed to initialize:', err)
            state.error = err instanceof Error ? err.message : 'Failed to initialize'
            throw err
        }
    }

    // Update WebRTC address
    function updateWebRTCAddress(): void {
        if (!state.node) return

        const multiaddrs = state.node.getMultiaddrs()
        const webrtcAddr = multiaddrs.find(ma => WebRTC.matches(ma))

        if (webrtcAddr) {
            state.webrtcAddress = webrtcAddr.toString()
        }
    }

    // Connect to relay server
    async function connectToRelay(): Promise<void> {
        if (!state.node) return

        try {
            const relayAddress = config.public.relayAddress as string
            const ma = multiaddr(relayAddress)
            const connection = await state.node.dial(ma, {
                signal: AbortSignal.timeout(10000)
            })

            state.relayPeerId = connection.remotePeer.toString()
            state.relayConnected = true
            state.connectedPeers = state.connectedPeers.filter(p => p !== state.relayPeerId)

            console.log('✅ Connected to relay:', state.relayPeerId)

            // Wait for WebRTC address
            setTimeout(() => updateWebRTCAddress(), 2000)

        } catch (err) {
            console.error('Failed to connect to relay:', err)
            state.error = err instanceof Error ? err.message : 'Failed to connect'
        }
    }

    // Connect to a peer by multiaddr
    async function connectToPeer(address: string): Promise<void> {
        if (!state.node) throw new Error('Node not initialized')

        try {
            const ma = multiaddr(address)

            if (WebRTC.matches(ma)) {
                // Ping to establish WebRTC connection
                const rtt = await state.node.services.ping.ping(ma, {
                    signal: AbortSignal.timeout(30000)
                })
                console.log('✅ WebRTC connected, RTT:', rtt, 'ms')
            } else {
                await state.node.dial(ma, {
                    signal: AbortSignal.timeout(10000)
                })
                console.log('✅ Connected to peer')
            }
        } catch (err) {
            console.error('Failed to connect:', err)
            throw err
        }
    }

    // Get shareable WebRTC address
    function getShareableAddress(): string | null {
        if (state.webrtcAddress) {
            return state.webrtcAddress
        }

        // Fallback: construct from relay info
        if (state.relayConnected && state.relayPeerId && state.peerId) {
            const relayAddress = config.public.relayAddress as string
            return `${relayAddress}/p2p/${state.relayPeerId}/p2p-circuit/webrtc/p2p/${state.peerId}`
        }

        return null
    }

    // Stop the node
    async function stopNode(): Promise<void> {
        if (state.node) {
            await state.node.stop()
            state.node = null
            state.peerId = null
            state.isConnected = false
            state.relayConnected = false
            state.connectedPeers = []
            state.webrtcAddress = null
        }
    }

    return {
        state: readonly(state) as LibP2PState,
        initNode,
        connectToPeer,
        getShareableAddress,
        stopNode
    }
}
