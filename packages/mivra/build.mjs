// Builds the publishable `mivra` package (ADR-013): the CLI with the server bundled in, the extraction child,
// the migrations and the built web UI. Run `pnpm build` at the repo root first so web/dist exists.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
// The package is MIT (the repo's LICENSE). Code from other packages is bundled into dist/ and web/, so their
// notices ship with it: every production dependency of the web UI, plus the server packages inlined above.
// Packages npm installs as dependencies carry their own.
cpSync(here("../../LICENSE"), here("./LICENSE"));
writeFileSync(here("./THIRD_PARTY_NOTICES.md"), thirdPartyNotices());

function thirdPartyNotices() {
  const listed = (filter, prod = true) =>
    Object.entries(JSON.parse(execFileSync("pnpm", ["licenses", "list", ...(prod ? ["--prod"] : []), "--json", "--filter", filter], { cwd: here("../.."), encoding: "utf8" })))
      .flatMap(([license, entries]) => entries.map((entry) => ({ ...entry, license })));
  // The web UI's production dependencies are bundled into web/, and so is the CSS that styles.css imports from build
  // tools (Tailwind's base styles, tw-animate-css), though those are dev dependencies.
  const cssImports = new Set([...readFileSync(here("../web/src/styles.css"), "utf8").matchAll(/^@import\s+"([^"./][^"]*)"/gm)].map((m) => m[1]));
  const web = [...listed("@mivra/web"), ...listed("@mivra/web", false).filter((e) => cssImports.has(e.name))];
  const inlined = listed("@mivra/server").filter((e) => BUNDLED.some((re) => re.test(e.name)));
  const byName = new Map();
  for (const e of [...web, ...inlined]) if (!e.name.startsWith("@mivra/") && !byName.has(e.name)) byName.set(e.name, e);
  const missingCss = [...cssImports].filter((name) => !byName.has(name));
  if (missingCss.length) throw new Error(`styles.css imports ${missingCss.join(", ")}, but pnpm doesn't list it for @mivra/web.`);

  const included = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const ownText = (dir) => {
    const file = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
    return file ? readFileSync(join(dir, file), "utf8").trim() : undefined;
  };
  // A package that ships no license file needs a reviewed copy in notices/, or the build stops: its notice is required.
  const fallback = (name) => {
    const path = here(`./notices/${name.replace("/", "__")}.txt`);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  };
  const missing = [];
  const sections = included.map((e) => {
    const body = e.paths.map(ownText).find(Boolean) ?? fallback(e.name);
    if (!body) missing.push(e.name);
    return `## ${e.name} ${e.versions.join(", ")}\n\nLicense: ${e.license}${e.homepage ? ` (${e.homepage})` : ""}\n\n\`\`\`\n${body}\n\`\`\`\n`;
  });
  if (missing.length) {
    throw new Error(`No license text for ${missing.join(", ")}. Add the upstream license to packages/mivra/notices/ (see its README).`);
  }
  return `# Third-party notices\n\nMivra is MIT-licensed (see LICENSE). It bundles code from these packages, under their own licenses.\n\n${sections.join("\n")}`;
}

console.log(`Built mivra ${pkg.version}: dist/, drizzle/, web/ (${externals.size} external packages).`);
