import withPWAInit from 'next-pwa'

// next-pwa v5 always calls skipWaiting() regardless of the config option,
// which causes blank screens in standalone PWA mode after deploys (new SW
// deletes old cached chunks the running page still needs). We disable SW
// generation entirely and use a hand-written sw.js instead.
const withPWA = withPWAInit({
  dest: 'public',
  disable: true,
  register: false,
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  // firebase-admin and its firestore/messaging sub-packages use native Node.js
  // bindings that can't be webpack-bundled. Keep them external so Node.js
  // resolves them from node_modules at runtime.
  // Note: we no longer import firebase-admin/auth anywhere (replaced with a
  // direct jose-based verifier), so the jwks-rsa → jose ESM chain never loads.
  experimental: {
    serverComponentsExternalPackages: [
      'firebase-admin',
      'firebase-admin/app',
      'firebase-admin/firestore',
      'firebase-admin/messaging',
    ],
  },
  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default withPWA(nextConfig)
