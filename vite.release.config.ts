import { chmod, cp, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(repositoryRoot, "dist");

function isExternalDependency(id: string): boolean {
  if (id.startsWith("@noesis/")) return false;
  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
  return true;
}

function copyRuntimeAssets(): Plugin {
  return {
    name: "copy-noesis-runtime-assets",
    async closeBundle() {
      await Promise.all([
        cp(
          resolve(repositoryRoot, "packages/workspace/migrations"),
          resolve(outputRoot, "packages/workspace/migrations"),
          { recursive: true },
        ),
        cp(resolve(repositoryRoot, "apps/noesis/skills"), resolve(outputRoot, "apps/noesis/skills"), {
          recursive: true,
        }),
      ]);
      const executable = resolve(outputRoot, "cli.js");
      await writeFile(
        executable,
        '#!/usr/bin/env node\nimport "./apps/noesis/src/process-warnings.js";\nawait import("./apps/noesis/src/cli.js");\n',
        "utf8",
      );
      await chmod(executable, 0o755);
    },
  };
}

export default defineConfig({
  plugins: [copyRuntimeAssets()],
  build: {
    target: "node22",
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: true,
    rollupOptions: {
      external: isExternalDependency,
      input: [
        resolve(repositoryRoot, "apps/noesis/src/cli.ts"),
        resolve(repositoryRoot, "packages/codemode/src/runner.mjs"),
      ],
      output: {
        format: "es",
        preserveModules: true,
        preserveModulesRoot: repositoryRoot,
        entryFileNames: (chunk) => {
          const module = chunk.facadeModuleId;
          if (!module) return "[name].js";
          const extension = extname(module);
          const name = basename(module, extension);
          return module.endsWith("/packages/codemode/src/runner.mjs")
            ? `packages/codemode/src/${name}.mjs`
            : "[name].js";
        },
      },
    },
  },
  ssr: {
    noExternal: [/^@noesis\//u],
  },
});
