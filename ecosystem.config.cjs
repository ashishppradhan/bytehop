module.exports = {
    apps: [
        {
            name: 'bytehop-frontend',
            script: '.output/server/index.mjs',
            cwd: '/opt/bytehop',
            env: {
                PORT: 3000,
                NODE_ENV: 'production'
            }
        },
        {
            name: 'bytehop-relay',
            script: 'bun',
            args: 'relay/index.ts',
            cwd: '/opt/bytehop',
            env: {
                LIBP2P_PORT: 9090,
                HTTP_PORT: 3001,
                NODE_ENV: 'production'
            }
        }
    ]
}
