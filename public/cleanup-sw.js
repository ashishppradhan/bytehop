/**
 * ByteHop Cleanup Service Worker
 * 
 * Monitors for all tabs closing and cleans up OPFS storage.
 * Runs independently of the main page lifecycle.
 */

const CLEANUP_CHECK_INTERVAL = 3000 // 3 seconds
let cleanupTimer = null

async function cleanupOPFS() {
    try {
        const root = await navigator.storage.getDirectory()
        for await (const [name] of root.entries()) {
            if (name.startsWith('bytehop-')) {
                await root.removeEntry(name)
                console.log('[SW] 🗑️ Cleaned OPFS:', name)
            }
        }
    } catch (e) {
        // OPFS not available in this context
    }
}

// When a client (tab) sends a message, start monitoring
self.addEventListener('message', (event) => {
    if (event.data === 'bytehop-session-active') {
        // A tab is active, ensure we're monitoring
        if (!cleanupTimer) {
            cleanupTimer = setInterval(async () => {
                const clients = await self.clients.matchAll({ type: 'window' })
                if (clients.length === 0) {
                    // All tabs closed — clean up OPFS
                    console.log('[SW] No active tabs, cleaning up OPFS...')
                    await cleanupOPFS()
                    clearInterval(cleanupTimer)
                    cleanupTimer = null
                }
            }, CLEANUP_CHECK_INTERVAL)
        }
    }
})

// Also clean up when SW activates (e.g. after browser restart)
self.addEventListener('activate', (event) => {
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then(async (clients) => {
            if (clients.length === 0) {
                await cleanupOPFS()
            }
        })
    )
})
