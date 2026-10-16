import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components is intentionally off: this is a dynamic, DB-backed API app.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
