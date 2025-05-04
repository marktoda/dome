/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['avatars.githubusercontent.com'],
  },
  // For Cloudflare Pages compatibility
  // See: https://developers.cloudflare.com/pages/framework-guides/deploy-a-nextjs-site/
  output: 'standalone',
};

module.exports = nextConfig;
