/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-phantom",
    "@solana/wallet-adapter-solflare",
  ],
};
module.exports = nextConfig;