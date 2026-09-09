// Runtime configuration for the precompiled web server; no TypeScript compiler is needed.
export default {
  poweredByHeader: false,
  serverExternalPackages: ["argon2", "pg", "@prisma/adapter-pg"],
};
