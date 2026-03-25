/**
 * Vite Configuration with Performance Optimizations
 * Code splitting, lazy loading, bundle analysis
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [react()],

  build: {
    // Optimize build output
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // Remove console in production
        drop_debugger: true,
      },
      mangle: true,
    },

    // Code splitting strategy
    rollupOptions: {
      output: {
        // Vendor code splitting
        manualChunks: {
          // Core vendors
          react: ['react', 'react-dom'],

          // State management
          zustand: ['zustand'],

          // Animations
          framer: ['framer-motion'],

          // Icons
          lucide: ['lucide-react'],

          // UI libraries
          ui: ['@line/bot-sdk', 'discord.js'],

          // Utilities
          utils: ['uuid', 'crypto'],
        },

        // Optimize chunk naming
        entryFileNames: 'js/[name].[hash].js',
        chunkFileNames: 'js/[name].[hash].js',
        assetFileNames: ({ name }) => {
          if (/\.(gif|jpe?g|png|svg|webp)$/.test(name ?? '')) {
            return 'images/[name].[hash][extname]';
          } else if (/\.css$/.test(name ?? '')) {
            return 'css/[name].[hash][extname]';
          }
          return 'assets/[name].[hash][extname]';
        },
      },
    },

    // Optimize chunk size
    chunkSizeWarningLimit: 1000,

    // CSS splitting
    cssCodeSplit: true,

    // Source maps for debugging
    sourcemap: 'hidden', // Hidden in production, but available for error tracking
  },

  // Development optimizations
  server: {
    // Optimize dependency pre-bundling
    deps: {
      inline: ['framer-motion'],
    },
  },

  // Optimizations
  optimizeDeps: {
    // Pre-bundle dependencies
    include: ['react', 'react-dom', 'zustand', 'framer-motion', 'lucide-react'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },

  plugins: [
    react({
      // Fast Refresh
      fastRefresh: true,
    }),

    // Bundle analysis (only in build)
    process.env.ANALYZE &&
      visualizer({
        open: true,
        gzipSize: true,
        brotliSize: true,
      }),
  ].filter(Boolean),

  // Performance hints
  esbuild: {
    // Reduce build size
    drop: ['console', 'debugger'],
  },
});
