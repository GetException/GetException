import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
    symbolication: "src/source-maps/symbolication.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  noExternal: [/^@getexception\//],
  external: ["@prisma/adapter-pg", "@prisma/client", "pg"],
});
