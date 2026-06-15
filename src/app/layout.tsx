import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import Script from 'next/script'
import { AuthProvider } from '@/contexts/AuthContext'
import { FamilyProvider } from '@/contexts/FamilyContext'
import { ToastProvider } from '@/contexts/ToastContext'
import { CaptureProvider } from '@/contexts/CaptureContext'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Family Command Center',
  description: 'Your family organization hub',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Family CC',
  },
}

export const viewport: Viewport = {
  themeColor: '#3B82F6',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className={inter.className}>
        {/* Register our hand-written SW (replaces the next-pwa generated one) */}
        <Script id="sw-register" strategy="afterInteractive">{`
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
          }
        `}</Script>
        <AuthProvider>
          <FamilyProvider>
            <ToastProvider>
              <CaptureProvider>
                {children}
              </CaptureProvider>
            </ToastProvider>
          </FamilyProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
