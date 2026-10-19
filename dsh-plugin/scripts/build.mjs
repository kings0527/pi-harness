// Build the dsh plugin bundle.
//
// Node refuses to strip TypeScript inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and dsh loads this package from
// a profile's node_modules, so the shipped artifact is plain JavaScript. The
// core is bundled in: dsh's loader resolves a plugin by module name, and a
// relative import reaching outside the package would depend on the profile's
// own layout. `@deepseek-ai/*` stays external — those are dsh's own singletons
// (two copies of cordis would mean two service registries).
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  external: ["@deepseek-ai/*"],
  logLevel: "info",
});
