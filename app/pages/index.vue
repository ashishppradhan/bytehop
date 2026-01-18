<script setup lang="ts">
import type { Libp2p } from '@libp2p/interface'

const toast = useToast()

// libp2p state
const { state: libp2pState, initNode, connectToPeer, getShareableAddress } = useLibp2p()

// File transfer - pass node reference
const nodeRef = computed(() => libp2pState.node as Libp2p | null)
const { transfers, receivedFiles, sendFile, downloadFile, clearTransfer } = useFileTransfer(nodeRef)

// UI State
const peerAddressInput = ref('')
const selectedFile = ref<File | null>(null)
const selectedPeer = ref<string | undefined>(undefined)
const isConnecting = ref(false)
const isSending = ref(false)

// Initialize on mount
onMounted(async () => {
  try {
    await initNode()
    toast.add({
      title: 'Connected',
      description: 'P2P node initialized successfully',
      color: 'success'
    })
  } catch (err) {
    toast.add({
      title: 'Connection Failed',
      description: err instanceof Error ? err.message : 'Failed to initialize',
      color: 'error'
    })
  }
})

// Connect to peer
async function handleConnect(): Promise<void> {
  if (!peerAddressInput.value.trim()) return
  
  isConnecting.value = true
  try {
    await connectToPeer(peerAddressInput.value.trim())
    toast.add({
      title: 'Peer Connected',
      description: 'Successfully connected to peer',
      color: 'success'
    })
    peerAddressInput.value = ''
  } catch (err) {
    toast.add({
      title: 'Connection Failed',
      description: err instanceof Error ? err.message : 'Failed to connect',
      color: 'error'
    })
  } finally {
    isConnecting.value = false
  }
}

// Handle file selection
function handleFileSelect(event: Event): void {
  const target = event.target as HTMLInputElement
  if (target.files?.length) {
    selectedFile.value = target.files[0] ?? null
  }
}

// Send file to selected peer
async function handleSendFile(): Promise<void> {
  if (!selectedFile.value || !selectedPeer.value) return
  
  isSending.value = true
  try {
    await sendFile(selectedFile.value, selectedPeer.value)
    toast.add({
      title: 'File Sent',
      description: `${selectedFile.value.name} sent successfully`,
      color: 'success'
    })
    selectedFile.value = null
  } catch (err) {
    toast.add({
      title: 'Send Failed',
      description: err instanceof Error ? err.message : 'Failed to send file',
      color: 'error'
    })
  } finally {
    isSending.value = false
  }
}

// Copy address to clipboard
async function copyAddress(): Promise<void> {
  const addr = getShareableAddress()
  if (addr) {
    await navigator.clipboard.writeText(addr)
    toast.add({
      title: 'Copied!',
      description: 'Your address has been copied',
      color: 'success'
    })
  }
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
</script>

<template>
  <UContainer class="py-8 max-w-4xl">
    <!-- Header -->
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold mb-2">ByteHop</h1>
      <p class="opacity-60">Browser-to-browser file sharing with libp2p WebRTC</p>
      
      <div class="flex justify-center gap-2 mt-4">
        <UBadge :color="libp2pState.isConnected ? 'success' : 'error'">
          {{ libp2pState.isConnected ? 'Node Active' : 'Disconnected' }}
        </UBadge>
        <UBadge :color="libp2pState.relayConnected ? 'success' : 'warning'" variant="soft">
          Relay: {{ libp2pState.relayConnected ? 'Connected' : 'Not Connected' }}
        </UBadge>
      </div>
    </div>

    <!-- Your Address -->
    <UCard class="mb-6">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-identification" class="size-5" />
          <span class="font-semibold">Your Address</span>
        </div>
      </template>

      <div v-if="libp2pState.peerId" class="space-y-3">
        <div class="text-xs font-mono bg-gray-100 dark:bg-gray-800 p-3 rounded-lg break-all">
          {{ getShareableAddress() || `Peer ID: ${libp2pState.peerId}` }}
        </div>
        <UButton 
          color="primary" 
          variant="soft" 
          icon="i-heroicons-clipboard-document"
          :disabled="!getShareableAddress()"
          @click="copyAddress"
        >
          Copy Address
        </UButton>
        <p class="text-xs opacity-50">Share this address with others to connect</p>
      </div>
      <div v-else class="text-center py-4 opacity-60">
        Initializing...
      </div>
    </UCard>

    <div class="grid md:grid-cols-2 gap-6">
      <!-- Connect to Peer -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-link" class="size-5" />
            <span class="font-semibold">Connect to Peer</span>
          </div>
        </template>

        <div class="space-y-4">
          <UFormField label="Peer Address">
            <UTextarea
              v-model="peerAddressInput"
              placeholder="Paste peer's address here..."
              :rows="3"
              class="font-mono text-xs"
            />
          </UFormField>

          <UButton
            color="primary"
            block
            :loading="isConnecting"
            :disabled="!peerAddressInput.trim() || !libp2pState.isConnected"
            @click="handleConnect"
          >
            <UIcon name="i-heroicons-link" class="size-4" />
            Connect
          </UButton>

          <!-- Connected Peers -->
          <div v-if="libp2pState.connectedPeers.length > 0" class="space-y-2">
            <p class="text-sm font-medium">Connected Peers:</p>
            <div 
              v-for="peer in libp2pState.connectedPeers" 
              :key="peer"
              class="flex items-center gap-2 p-2 rounded-lg bg-gray-100 dark:bg-gray-800"
            >
              <UIcon name="i-heroicons-user-circle" class="size-5 text-success" />
              <span class="font-mono text-xs truncate flex-1">{{ peer.substring(0, 20) }}...</span>
              <UButton
                size="xs"
                color="primary"
                variant="soft"
                @click="selectedPeer = peer"
              >
                Select
              </UButton>
            </div>
          </div>
        </div>
      </UCard>

      <!-- Send File -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-arrow-up-tray" class="size-5" />
            <span class="font-semibold">Send File</span>
          </div>
        </template>

        <div class="space-y-4">
          <input
            id="file-input"
            type="file"
            class="hidden"
            @change="handleFileSelect"
          >
          
          <label
            for="file-input"
            class="block p-6 border-2 border-dashed rounded-lg text-center cursor-pointer hover:border-primary transition-colors"
            :class="selectedFile ? 'border-success' : 'border-gray-300 dark:border-gray-700'"
          >
            <UIcon 
              :name="selectedFile ? 'i-heroicons-document-check' : 'i-heroicons-cloud-arrow-up'" 
              class="size-10 mx-auto mb-2 opacity-50" 
            />
            <p v-if="selectedFile" class="font-medium">{{ selectedFile.name }}</p>
            <p v-else class="opacity-60">Click to select a file</p>
            <p v-if="selectedFile" class="text-sm opacity-60">{{ formatSize(selectedFile.size) }}</p>
          </label>

          <UFormField v-if="selectedFile" label="Send to">
            <USelect
              v-model="selectedPeer"
              :items="libp2pState.connectedPeers.map(p => ({ label: p.substring(0, 20) + '...', value: p }))"
              placeholder="Select a connected peer"
            />
          </UFormField>

          <UButton
            color="success"
            block
            :loading="isSending"
            :disabled="!selectedFile || !selectedPeer"
            @click="handleSendFile"
          >
            <UIcon name="i-heroicons-paper-airplane" class="size-4" />
            Send File
          </UButton>
        </div>
      </UCard>
    </div>

    <!-- Transfers -->
    <UCard v-if="transfers.size > 0" class="mt-6">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-path" class="size-5" />
          <span class="font-semibold">Transfers</span>
        </div>
      </template>

      <div class="space-y-3">
        <div 
          v-for="[id, transfer] in transfers" 
          :key="id"
          class="p-3 rounded-lg bg-gray-100 dark:bg-gray-800"
        >
          <div class="flex items-center gap-3">
            <UIcon 
              :name="transfer.direction === 'send' ? 'i-heroicons-arrow-up-tray' : 'i-heroicons-arrow-down-tray'" 
              class="size-5"
              :class="transfer.direction === 'send' ? 'text-primary' : 'text-success'"
            />
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">{{ transfer.filename }}</p>
              <p class="text-xs opacity-60">
                {{ formatSize(transfer.transferred) }} / {{ formatSize(transfer.size) }}
              </p>
            </div>
            <UBadge 
              :color="transfer.status === 'completed' ? 'success' : transfer.status === 'error' ? 'error' : 'info'"
            >
              {{ transfer.status }}
            </UBadge>
          </div>
          <UProgress 
            v-if="transfer.status === 'transferring'"
            :value="(transfer.transferred / transfer.size) * 100" 
            class="mt-2"
          />
        </div>
      </div>
    </UCard>

    <!-- Received Files -->
    <UCard v-if="receivedFiles.length > 0" class="mt-6">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-folder-arrow-down" class="size-5" />
          <span class="font-semibold">Received Files</span>
        </div>
      </template>

      <div class="space-y-2">
        <div 
          v-for="file in receivedFiles" 
          :key="file.filename"
          class="flex items-center gap-3 p-3 rounded-lg bg-gray-100 dark:bg-gray-800"
        >
          <UIcon name="i-heroicons-document" class="size-5" />
          <span class="font-medium flex-1 truncate">{{ file.filename }}</span>
          <span class="text-sm opacity-60">{{ formatSize(file.blob.size) }}</span>
          <UButton
            size="sm"
            color="success"
            @click="downloadFile(file.filename)"
          >
            Download
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- Footer -->
    <div class="mt-12 text-center text-sm opacity-50">
      Direct browser-to-browser P2P • No server storage • Encrypted with Noise
    </div>
  </UContainer>
</template>
