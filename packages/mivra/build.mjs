// Builds the publishable `mivra` package (ADR-013): the CLI with the server bundled in, the extraction child,
// the migrations and the built web UI. Run `pnpm build` at the repo root first so web/dist exists.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here("./package.json"), "utf8"));

// Bundled rather than installed: the workspace packages aren't published, and the OpenRouter provider carries a
// pnpm patch (patches/) that an npm install wouldn't apply.
const BUNDLED = [/^@mivra\//, /^@openrouter\/ai-sdk-provider(\/|$)/];
const packageName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const externals = new Set();

const webDist = here("../web/dist/index.html");
if (!existsSync(webDist)) {
  console.error("packages/web/dist is missing: run `pnpm build` at the repo root first.");
  process.exit(1);
}

rmSync(here("./dist"), { recursive: true, force: true });
await build({
  entryPoints: { cli: here("./src/cli.ts"), "extract-child": here("../server/src/documents/extract-child.ts") },
  outdir: here("./dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["@mivra/source"],
  sourcemap: "linked",
  legalComments: "linked",
  logLevel: "warning",
  plugins: [
    {
      name: "externals",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (builtins.has(args.path) || BUNDLED.some((re) => re.test(args.path))) return undefined;
          externals.add(packageName(args.path));
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

// Every package the bundle still imports must be a dependency, or `npx mivra` fails at start.
const missing = [...externals].filter((name) => !pkg.dependencies[name]);
const unused = Object.keys(pkg.dependencies).filter((name) => !externals.has(name));
if (missing.length || unused.length) {
  if (missing.length) console.error(`Imported but not in dependencies: ${missing.join(", ")}`);
  if (unused.length) console.error(`In dependencies but never imported: ${unused.join(", ")}`);
  process.exit(1);
}

for (const [from, to] of [["../server/drizzle", "./drizzle"], ["../web/dist", "./web"]]) {
  rmSync(here(to), { recursive: true, force: true });
  cpSync(here(from), here(to), { recursive: true });
}
console.log(`Built mivra ${pkg.version}: dist/, drizzle/, web/ (${externals.size} external packages).`);
