// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  // Disable SSR - libp2p only works in browser
  ssr: false,

  runtimeConfig: {
    public: {
      relayAddress: process.env.RELAY_ADDRESS || '/ip4/127.0.0.1/tcp/9090/ws'
    }
  },

  app: {
    head: {
      title: 'ByteHop',
      meta: [
        { name: 'description', content: 'Browser-to-browser P2P file sharing with libp2p' }
      ]
    }
  },

  vite: {
    // Ensure subpath exports are resolved
    resolve: {
      preserveSymlinks: true
    },
    optimizeDeps: {
      include: [
        'libp2p',
        '@libp2p/webrtc',
        '@libp2p/websockets',
        '@chainsafe/libp2p-noise',
        '@chainsafe/libp2p-yamux'
      ],
      esbuildOptions: {
        target: 'esnext'
      }
    },
    define: {
      'process.env.NODE_DEBUG': 'false',
      'global': 'globalThis'
    },
    build: {
      target: 'esnext'
    }
  }
})
