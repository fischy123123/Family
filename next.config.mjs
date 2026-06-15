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
