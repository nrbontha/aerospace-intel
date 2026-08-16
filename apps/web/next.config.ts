import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@asi/config",
    "@asi/contracts",
    "@asi/database",
    "@asi/ui",
  ],
};

export default nextConfig;
