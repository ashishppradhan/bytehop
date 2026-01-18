// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
    rules: {
        // Vue
        'vue/multi-word-component-names': 'off',
        'vue/no-multiple-template-root': 'off',

        // TypeScript
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_'
        }],

        // Allow console.log for P2P debugging
        'no-console': 'off',
    }
})
