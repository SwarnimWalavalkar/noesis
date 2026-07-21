import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const allowedErrorClasses = new Set([
  "apps/noesis/src/onboarding.ts:OnboardingCancelledError",
  "packages/config/src/index.ts:NoesisConfigError",
  "packages/ledger/src/index.ts:LedgerConflictError",
  "packages/ledger/src/index.ts:LedgerIntegrityError",
]);

async function filesBelow(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? await filesBelow(path) : [path];
      }),
    )
  ).flat();
}

async function firstPartyFiles(): Promise<readonly string[]> {
  return (
    await Promise.all(
      ["apps", "packages"].map(async (root) => await filesBelow(resolve(repositoryRoot, root))),
    )
  ).flat();
}

function relativePath(path: string): string {
  return relative(repositoryRoot, path);
}

function parseSource(path: string, source: string): ts.SourceFile {
  const kind = extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
}

function directErrorSubclass(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
  const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const extendedType = heritage?.types[0];
  return (
    heritage?.types.length === 1 &&
    extendedType !== undefined &&
    ts.isIdentifier(extendedType.expression) &&
    extendedType.expression.text === "Error"
  );
}

function moduleSpecifiers(sourceFile: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

describe("first-party architecture boundaries", () => {
  test("keeps exactly the four native Error subclasses as first-party classes", async () => {
    const files = (await firstPartyFiles()).filter((path) => /\.tsx?$/.test(path));
    const found = new Set<string>();
    const violations: string[] = [];
    for (const path of files) {
      const sourceFile = parseSource(path, await readFile(path, "utf8"));
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          const name = node.name?.text ?? "<anonymous>";
          const key = `${relativePath(path)}:${name}`;
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          if (!allowedErrorClasses.has(key) || !directErrorSubclass(node))
            violations.push(`${key}:${position.line + 1}:${position.character + 1}`);
          else found.add(key);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(violations).toEqual([]);
    expect([...found].sort()).toEqual([...allowedErrorClasses].sort());
  });

  test("owns Pi runtime and model imports only in runtime-pi and Pi TUI primitives only in tui", async () => {
    const files = (await firstPartyFiles()).filter((path) => /\.tsx?$/.test(path));
    const violations: string[] = [];
    for (const path of files) {
      const localPath = relativePath(path);
      const sourceFile = parseSource(path, await readFile(path, "utf8"));
      for (const specifier of moduleSpecifiers(sourceFile)) {
        if (!specifier.startsWith("@earendil-works/pi-")) continue;
        const allowedRuntimePi =
          localPath.startsWith("packages/runtime-pi/") &&
          (specifier === "@earendil-works/pi-agent-core" ||
            specifier.startsWith("@earendil-works/pi-agent-core/") ||
            specifier === "@earendil-works/pi-ai" ||
            specifier.startsWith("@earendil-works/pi-ai/"));
        const allowedTui =
          localPath.startsWith("packages/tui/") &&
          (specifier === "@earendil-works/pi-tui" || specifier.startsWith("@earendil-works/pi-tui/"));
        if (!allowedRuntimePi && !allowedTui) violations.push(`${localPath}:${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("forbids first-party TypeBox imports and direct dependencies", async () => {
    const files = await firstPartyFiles();
    const sourceViolations: string[] = [];
    for (const path of files.filter((candidate) => /\.tsx?$/.test(candidate))) {
      const sourceFile = parseSource(path, await readFile(path, "utf8"));
      for (const specifier of moduleSpecifiers(sourceFile))
        if (
          specifier === "@sinclair/typebox" ||
          specifier.startsWith("@sinclair/typebox/") ||
          specifier === "typebox" ||
          specifier.startsWith("typebox/")
        )
          sourceViolations.push(`${relativePath(path)}:${specifier}`);
    }

    const manifests = [
      resolve(repositoryRoot, "package.json"),
      ...files.filter((path) => path.endsWith("package.json")),
    ];
    const dependencyViolations: string[] = [];
    for (const path of manifests) {
      const manifest = JSON.parse(await readFile(path, "utf8")) as {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
        readonly peerDependencies?: Readonly<Record<string, string>>;
      };
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      for (const name of ["@sinclair/typebox", "typebox"])
        if (name in dependencies) dependencyViolations.push(`${relativePath(path)}:${name}`);
    }

    expect(sourceViolations).toEqual([]);
    expect(dependencyViolations).toEqual([]);
  });
});
