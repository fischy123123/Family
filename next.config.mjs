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
  // firebase-admin v14 → google-auth-library v10 → jwks-rsa v4 → jose v6 (ESM-only).
  // Webpack transforms dynamic import('jose') inside jwks-rsa into require(),
  // breaking at runtime. Marking the full chain as external keeps them out of
  // the webpack bundle so Node.js resolves them natively (handles ESM correctly).
  experimental: {
    serverComponentsExternalPackages: [
      'firebase-admin',
      'firebase-admin/app',
      'firebase-admin/auth',
      'firebase-admin/firestore',
      'google-auth-library',
      'jwks-rsa',
      'jose',
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Belt-and-suspenders: also add these to webpack externals so the
      // bundler never touches them regardless of where they're imported from.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        'firebase-admin',
        'google-auth-library',
        'jwks-rsa',
        'jose',
      ]
    }
    return config
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
