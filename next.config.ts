import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import type { NextConfig } from "next";

export default function nextConfig(phase: string): NextConfig {
  return {
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    reactStrictMode: true,
    output: "standalone",
    outputFileTracingRoot: process.cwd(),
    outputFileTracingIncludes: {
      "/*": [
        "./src/lib/db/migrations/*.sql",
        "./scripts/**/*",
        "./vendor/mini-swe-agent/**/*",
      ],
    },
    outputFileTracingExcludes: {
      "/*": [
        "./desktop-resources/**/*",
        "./release/**/*",
        "./.desktop-cache/**/*",
        "./data/**/*",
        "./test-results/**/*",
        "./.next-dev/**/*",
      ],
    },
    serverExternalPackages: ["better-sqlite3"],
  };
}
