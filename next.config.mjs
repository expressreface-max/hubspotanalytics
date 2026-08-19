/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the v0 preview iframe (served from *.vusercontent.net) to load HMR
  // resources without being cross-origin-blocked (which shows a blank preview).
  allowedDevOrigins: ["*.vusercontent.net"],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
