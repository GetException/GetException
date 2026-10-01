import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: [
    "@getexception/db",
    "@getexception/config",
    "@getexception/protocol",
  ],
  serverExternalPackages: ["argon2", "pg", "@prisma/adapter-pg"],
  experimental: { cpus: 2 },
};

export default config;
