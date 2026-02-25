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
import { multiaddr } from '@multiformats/multiaddr'
import { WebRTC } from '@multiformats/multiaddr-matcher'

// Define the services type for our libp2p node
interface LibP2PServices {
    identify: Identify
    identifyPush: IdentifyPush
    ping: Ping
    [key: string]: unknown
}

type LibP2PNode = Libp2p<LibP2PServices>

export interface LibP2PState {
    node: LibP2PNode | null
    peerId: string | null
    isConnected: boolean
    relayConnected: boolean
    relayPeerId: string | null
    connectedPeers: string[]
    webrtcAddress: string | null
    shareCode: string | null
    error: string | null
    isReconnecting: boolean
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
        shareCode: null,
        error: null,
        isReconnecting: false
    })

    // ── Reconnection internals ──────────────────────────────────
    let relayReconnectTimer: ReturnType<typeof setTimeout> | null = null
    let relayReconnectAttempt = 0
    const MAX_RELAY_RECONNECT_DELAY_MS = 30_000 // cap backoff at 30 s

    // Peer ID → last known multiaddr (for reconnection after drops)
    const knownPeers = new Map<string, string>()

    // ── sessionStorage keys ─────────────────────────────────────
    const SS_KNOWN_PEERS = 'bytehop:knownPeers'   // JSON: { peerId: address }[]
    const SS_LAST_CODE = 'bytehop:lastPeerCode'    // The code we last used to connect

    function persistKnownPeers(): void {
        try {
            const entries = Object.fromEntries(knownPeers)
            sessionStorage.setItem(SS_KNOWN_PEERS, JSON.stringify(entries))
        } catch { /* sessionStorage not available */ }
    }

    function restoreKnownPeers(): void {
        try {
            const raw = sessionStorage.getItem(SS_KNOWN_PEERS)
            if (!raw) return
            const entries = JSON.parse(raw) as Record<string, string>
            for (const [peerId, address] of Object.entries(entries)) {
                knownPeers.set(peerId, address)
            }
        } catch { /* ignore */ }
    }

    /** After a full page reload, try to reconnect to every previously-known peer */
    async function reconnectSavedPeers(): Promise<void> {
        // First try: re-use the share code we connected with (most reliable)
        const savedCode = sessionStorage.getItem(SS_LAST_CODE)
        if (savedCode) {
            try {
                console.log(`🔄 Reconnecting with saved code: ${savedCode}`)
                await connectWithCode(savedCode)
                return // success — code resolved to peer address and connected
            } catch {
                console.warn('🔄 Saved code reconnect failed, trying direct addresses')
            }
        }

        // Fallback: try each known peer address directly
        for (const [peerId, address] of knownPeers) {
            if (peerId === state.relayPeerId) continue
            if (state.connectedPeers.includes(peerId)) continue
            attemptPeerReconnect(peerId, address)
        }
    }

    function scheduleRelayReconnect(): void {
        if (relayReconnectTimer) return // already scheduled
        state.isReconnecting = true
        const delay = Math.min(1000 * 2 ** relayReconnectAttempt, MAX_RELAY_RECONNECT_DELAY_MS)
        console.log(`🔄 Relay reconnect in ${delay}ms (attempt ${relayReconnectAttempt + 1})`)
        relayReconnectTimer = setTimeout(async () => {
            relayReconnectTimer = null
            relayReconnectAttempt++
            await connectToRelay()
            // If still not connected, schedule another attempt
            if (!state.relayConnected) {
                scheduleRelayReconnect()
            }
        }, delay)
    }

    async function attemptPeerReconnect(peerId: string, address: string, attempt = 0): Promise<void> {
        const MAX_ATTEMPTS = 3
        if (attempt >= MAX_ATTEMPTS || !state.node || !state.relayConnected) return
        // Skip if already reconnected
        if (state.connectedPeers.includes(peerId)) return

        const delay = 2000 * 2 ** attempt // 2s, 4s, 8s
        await new Promise(r => setTimeout(r, delay))

        // Re-check after delay
        if (state.connectedPeers.includes(peerId)) return

        try {
            await connectToPeer(address)
            console.log(`🔄 Reconnected to peer: ${peerId.substring(0, 16)}...`)
        } catch {
            console.warn(`🔄 Reconnect attempt ${attempt + 1}/${MAX_ATTEMPTS} failed for ${peerId.substring(0, 16)}...`)
            await attemptPeerReconnect(peerId, address, attempt + 1)
        }
    }

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

                // Remember address for reconnection (in-memory + sessionStorage)
                knownPeers.set(peerId, event.detail.remoteAddr.toString())
                persistKnownPeers()

                // Don't add relay to connected peers
                if (peerId !== state.relayPeerId && !state.connectedPeers.includes(peerId)) {
                    state.connectedPeers.push(peerId)
                }

                updateWebRTCAddress()
            })

            node.addEventListener('connection:close', (event) => {
                const peerId = event.detail.remotePeer.toString()

                // Relay dropped — schedule reconnect
                if (peerId === state.relayPeerId) {
                    state.relayConnected = false
                    state.webrtcAddress = null
                    console.log('⚠️ Relay connection lost')
                    scheduleRelayReconnect()
                    return
                }

                state.connectedPeers = state.connectedPeers.filter(p => p !== peerId)

                // Attempt to reconnect to known peer
                const knownAddr = knownPeers.get(peerId)
                if (knownAddr) {
                    console.log(`⚠️ Peer ${peerId.substring(0, 16)}... disconnected, attempting reconnect`)
                    attemptPeerReconnect(peerId, knownAddr)
                }
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

            // ── Restore saved peers after page reload ────────────
            restoreKnownPeers()
            if (knownPeers.size > 0) {
                console.log(`🔄 Found ${knownPeers.size} saved peer(s), attempting reconnect...`)
                // Slight delay to let relay reservation settle
                setTimeout(() => reconnectSavedPeers(), 3000)
            }

            // ── Mobile / tab-switch recovery ────────────────────
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', async () => {
                    if (document.visibilityState !== 'visible' || !state.node) return

                    console.log('👁️ Page became visible, checking connections...')

                    // Check relay health
                    const relayAlive = state.node.getConnections()
                        .some(c => c.remotePeer.toString() === state.relayPeerId)
                    if (!relayAlive && state.relayConnected) {
                        state.relayConnected = false
                        state.webrtcAddress = null
                        scheduleRelayReconnect()
                    } else if (!state.relayConnected) {
                        scheduleRelayReconnect()
                    }

                    // Check each known peer
                    for (const [peerId, address] of knownPeers) {
                        if (peerId === state.relayPeerId) continue
                        const peerAlive = state.node.getConnections()
                            .some(c => c.remotePeer.toString() === peerId)
                        if (!peerAlive && state.connectedPeers.includes(peerId)) {
                            state.connectedPeers = state.connectedPeers.filter(p => p !== peerId)
                            attemptPeerReconnect(peerId, address)
                        }
                    }
                })
            }

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
            state.isReconnecting = false
            relayReconnectAttempt = 0
            if (relayReconnectTimer) { clearTimeout(relayReconnectTimer); relayReconnectTimer = null }
            state.connectedPeers = state.connectedPeers.filter(p => p !== state.relayPeerId)

            console.log('✅ Connected to relay:', state.relayPeerId)

            // Wait for WebRTC address (relay needs a moment to set up reservation)
            setTimeout(() => updateWebRTCAddress(), 2000)

        } catch (err) {
            console.error('Failed to connect to relay:', err)
            state.error = err instanceof Error ? err.message : 'Failed to connect'
        }
    }

    // Generate a short share code
    async function generateShareCode(): Promise<string> {
        const address = getShareableAddress()
        if (!address) {
            throw new Error('No shareable address available')
        }

        const codeApiUrl = config.public.codeApiUrl as string
        const response = await fetch(`${codeApiUrl}/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        })

        if (!response.ok) {
            const error = await response.json()
            throw new Error(error.error || 'Failed to generate code')
        }

        const { code } = await response.json()
        state.shareCode = code
        console.log('📝 Generated share code:', code)
        return code
    }

    // Connect using a share code
    async function connectWithCode(code: string): Promise<void> {
        const codeApiUrl = config.public.codeApiUrl as string
        const response = await fetch(`${codeApiUrl}/code?code=${code}`)

        if (!response.ok) {
            const error = await response.json()
            throw new Error(error.error || 'Invalid code')
        }

        const { address } = await response.json()
        console.log('🔍 Resolved code to address:', address.substring(0, 50) + '...')

        // Save code for reconnection after page reload
        try { sessionStorage.setItem(SS_LAST_CODE, code) } catch { /* ignore */ }

        await connectToPeer(address)
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
        if (relayReconnectTimer) { clearTimeout(relayReconnectTimer); relayReconnectTimer = null }
        knownPeers.clear()
        // Clear saved session so we don't auto-reconnect on next load
        try {
            sessionStorage.removeItem(SS_KNOWN_PEERS)
            sessionStorage.removeItem(SS_LAST_CODE)
        } catch { /* ignore */ }
        if (state.node) {
            await state.node.stop()
            state.node = null
            state.peerId = null
            state.isConnected = false
            state.relayConnected = false
            state.isReconnecting = false
            state.connectedPeers = []
            state.webrtcAddress = null
            state.shareCode = null
        }
    }

    return {
        state: readonly(state) as LibP2PState,
        initNode,
        connectToPeer,
        connectWithCode,
        generateShareCode,
        getShareableAddress,
        stopNode
    }
}
