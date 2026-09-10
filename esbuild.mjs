import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: false,
  logLevel: "info"
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"]
  }),
  build({
    ...shared,
    entryPoints: ["src/editor-bridge.ts"],
    outfile: "dist/editor-bridge.js"
  })
]);
