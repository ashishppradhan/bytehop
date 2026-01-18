/**
 * File Transfer composable using byteStream from @libp2p/utils
 * 
 * Based on official js-libp2p-example-webrtc-private-to-private
 */

import type { Libp2p, Stream } from '@libp2p/interface'
import { byteStream } from '@libp2p/utils'
import { fromString } from 'uint8arrays'

// Protocol ID for file transfer
const FILE_TRANSFER_PROTOCOL = '/bytehop/file/1.0.0'

export interface FileTransferProgress {
    id: string
    filename: string
    size: number
    transferred: number
    status: 'pending' | 'transferring' | 'completed' | 'error'
    direction: 'send' | 'receive'
    error?: string
}

export interface ReceivedFile {
    filename: string
    blob: Blob
}

export function useFileTransfer(node: Ref<Libp2p | null>) {
    const transfers = ref<Map<string, FileTransferProgress>>(new Map())
    const receivedFiles = ref<ReceivedFile[]>([])
    let protocolRegistered = false

    // Watch for node to become available
    watch(() => node.value, async (newNode) => {
        if (newNode && !protocolRegistered) {
            await registerProtocol(newNode)
        }
    }, { immediate: true })

    // Register protocol handler
    async function registerProtocol(libp2p: Libp2p): Promise<void> {
        if (protocolRegistered) return

        try {
            // Unregister if exists
            try { await libp2p.unhandle(FILE_TRANSFER_PROTOCOL) } catch { /* ignore */ }

            await libp2p.handle(FILE_TRANSFER_PROTOCOL, async (incomingData) => {
                // Get stream from incoming data (handle both formats)
                const incoming = incomingData as unknown as { stream?: Stream, connection?: { remotePeer?: { toString(): string } } }
                const stream = incoming.stream ?? (incomingData as Stream)
                const connection = incoming.connection

                console.log('📥 Incoming file transfer from:', connection?.remotePeer?.toString() ?? 'unknown peer')

                try {
                    await handleIncomingTransfer(stream)
                } catch (err) {
                    console.error('📥 Error in handleIncomingTransfer:', err)
                }
            })

            protocolRegistered = true
            console.log('✅ File transfer protocol registered')
        } catch (err) {
            console.error('Failed to register protocol:', err)
        }
    }

    // Handle incoming file transfer
    async function handleIncomingTransfer(stream: Stream): Promise<void> {
        const transferId = crypto.randomUUID()

        try {
            const bytes = byteStream(stream)

            // Read metadata length (4 bytes)
            const lenBufRaw = await bytes.read({ bytes: 4 })
            const lenBytes = new Uint8Array(lenBufRaw.subarray())
            const metadataLength = new DataView(lenBytes.buffer).getUint32(0)

            if (metadataLength > 10000) {
                throw new Error(`Invalid metadata length: ${metadataLength}`)
            }

            // Read metadata
            const metaBufRaw = await bytes.read({ bytes: metadataLength })
            const metaBytes = new Uint8Array(metaBufRaw.subarray())
            const metadata = JSON.parse(new TextDecoder().decode(metaBytes))

            transfers.value.set(transferId, {
                id: transferId,
                filename: metadata.filename,
                size: metadata.size,
                transferred: 0,
                status: 'transferring',
                direction: 'receive'
            })

            // Prepare for streaming (try OPFS first)
            let writable: any = null // FileSystemWritableFileStream
            let fileHandle: any = null // FileSystemFileHandle
            const chunks: Uint8Array[] = [] // Fallback memory buffer

            try {
                const root = await navigator.storage.getDirectory()
                fileHandle = await root.getFileHandle(`bytehop-${transferId}`, { create: true })
                writable = await fileHandle.createWritable()
                console.log('💾 Using OPFS for file storage')
            } catch (e) {
                console.warn('⚠️ OPFS not available/failed, falling back to memory:', e)
            }

            // Read file data in chunks to avoid buffer overflow
            let remaining = metadata.size
            const CHUNK_SIZE = 1024 * 64 // 64KB chunks

            while (remaining > 0) {
                const readSize = Math.min(remaining, CHUNK_SIZE)
                const chunkRaw = await bytes.read({ bytes: readSize })
                const chunk = new Uint8Array(chunkRaw.subarray())

                if (writable) {
                    await writable.write(chunk)
                } else {
                    chunks.push(chunk)
                }

                remaining -= chunk.length

                // Update progress
                const transfer = transfers.value.get(transferId)
                if (transfer) {
                    transfer.transferred = metadata.size - remaining
                }
            }

            // Finalize
            let finalBlob: Blob
            if (writable) {
                await writable.close()
                finalBlob = await fileHandle.getFile()
            } else {
                finalBlob = new Blob(chunks as any)
            }

            // Update transfer
            const transfer = transfers.value.get(transferId)!
            transfer.status = 'completed'

            receivedFiles.value.push({
                filename: metadata.filename,
                blob: finalBlob
            })

            console.log('✅ File received:', metadata.filename)
            await stream.close()

        } catch (err) {
            console.error('❌ Error receiving file:', err)
            transfers.value.set(transferId, {
                id: transferId,
                filename: 'Unknown',
                size: 0,
                transferred: 0,
                status: 'error',
                direction: 'receive',
                error: err instanceof Error ? err.message : 'Transfer failed'
            })
        }
    }

    // Send file to peer
    async function sendFile(file: File, peerId: string): Promise<void> {
        if (!node.value) throw new Error('Node not initialized')

        const transferId = crypto.randomUUID()
        transfers.value.set(transferId, {
            id: transferId,
            filename: file.name,
            size: file.size,
            transferred: 0,
            status: 'pending',
            direction: 'send'
        })

        try {
            const { WebRTC } = await import('@multiformats/multiaddr-matcher')

            // Find connections to peer - prefer WebRTC
            const connections = node.value.getConnections()
            const peerConns = connections.filter(c => c.remotePeer.toString() === peerId)

            if (peerConns.length === 0) {
                throw new Error('Not connected to peer')
            }

            // Prefer WebRTC connection
            const webrtcConn = peerConns.find(c => WebRTC.matches(c.remoteAddr))
            const peerConn = webrtcConn ?? peerConns[0]!

            // Prepare data
            const metadata = JSON.stringify({ filename: file.name, size: file.size })
            const metaBytes = fromString(metadata)


            // Create length prefix
            const lenBuf = new Uint8Array(4)
            new DataView(lenBuf.buffer).setUint32(0, metaBytes.length)

            // Open protocol stream
            const stream = await node.value.dialProtocol(peerConn.remoteAddr, FILE_TRANSFER_PROTOCOL, {
                signal: AbortSignal.timeout(30000)
            })

            transfers.value.get(transferId)!.status = 'transferring'

            // Wrap with byteStream and write
            const bytes = byteStream(stream)
            await bytes.write(lenBuf)
            await bytes.write(metaBytes)

            // Write file data in chunks using slice() for memory efficiency
            let offset = 0
            const CHUNK_SIZE = 1024 * 64 // 64KB chunks

            while (offset < file.size) {
                const chunkBlob = file.slice(offset, offset + CHUNK_SIZE)
                const chunkBuf = await chunkBlob.arrayBuffer()
                const chunk = new Uint8Array(chunkBuf)

                await bytes.write(chunk)
                offset += chunk.length

                // Update progress
                const transfer = transfers.value.get(transferId)
                if (transfer) {
                    transfer.transferred = offset
                }
            }

            await stream.close()

            transfers.value.get(transferId)!.status = 'completed'
            console.log('✅ File sent:', file.name)

        } catch (err) {
            console.error('❌ Error sending file:', err)
            const transfer = transfers.value.get(transferId)
            if (transfer) {
                transfer.status = 'error'
                transfer.error = err instanceof Error ? err.message : 'Failed'
            }
            throw err
        }
    }

    // Download received file
    function downloadFile(filename: string): void {
        const file = receivedFiles.value.find(f => f.filename === filename)
        if (!file) return

        const url = URL.createObjectURL(file.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
    }

    // Clear transfer
    function clearTransfer(id: string): void {
        transfers.value.delete(id)
    }

    return {
        transfers: readonly(transfers),
        receivedFiles: readonly(receivedFiles),
        sendFile,
        downloadFile,
        clearTransfer
    }
}
