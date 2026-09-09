import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import ts from "typescript";

const allowed: Record<string, string[]> = {
  browser: ["protocol"],
  react: ["browser"],
  protocol: [],
  config: [],
  db: [],
  mail: [],
  web: ["db", "config", "protocol", "mail"],
  ingest: ["db", "config", "protocol"],
  worker: ["db", "config", "protocol", "mail"],
  "browser-spa": ["browser"],
  "react-spa": ["react"],
};

export function allowedDependency(from: string, to: string) {
  return allowed[from]?.includes(to) ?? false;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    ["node_modules", "dist", ".next", "generated"].includes(entry.name)
      ? []
      : entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
  );
}

export function checkArchitecture() {
  const errors: string[] = [];

  for (const base of ["apps", "packages", "fixtures"]) {
    for (const name of readdirSync(base)) {
      const directory = join(base, name);
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );

      if (manifest.name !== `@getexception/${name}`) {
        errors.push(`Unscoped package: ${directory}`);
      }

      if (
        ["browser", "react"].includes(name)
          ? manifest.publishConfig?.access !== "public"
          : manifest.private !== true
      ) {
        errors.push(`Invalid visibility: ${name}`);
      }

      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        if (
          dependency.startsWith("@getexception/") &&
          !dependency.startsWith("@getexception/sentry-") &&
          !allowedDependency(name, dependency.split("/")[1]!)
        ) {
          errors.push(`Dependency: ${name} -> ${dependency}`);
        }
      }

      for (const path of files(join(directory, "src"))) {
        if (!/\.[cm]?[jt]sx?$/.test(path)) {
          continue;
        }

        const source = readFileSync(path, "utf8");

        if (
          /\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.raw\s*\(|dangerouslySetInnerHTML|\.innerHTML\s*=|eval\s*\(/.test(
            source,
          )
        ) {
          errors.push(`Unsafe API: ${path}`);
        }

        const syntax = ts.createSourceFile(
          path,
          source,
          ts.ScriptTarget.Latest,
          true,
        );

        function visit(node: ts.Node) {
          const specifier =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) &&
                  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) &&
                      node.expression.text === "require"))
                ? node.arguments[0]
                : undefined;

          if (specifier && !ts.isStringLiteral(specifier)) {
            errors.push(`Computed runtime import: ${path}`);
          }

          if (specifier && ts.isStringLiteral(specifier)) {
            const target = specifier.text;

            if (target.startsWith(".")) {
              const destination = resolve(
                directory,
                relative(directory, join(path, "..")),
                target,
              );

              if (!destination.startsWith(resolve(directory) + "/")) {
                errors.push(`Cross-workspace relative import: ${path}`);
              }
            } else if (
              target.startsWith("@getexception/") &&
              !target.startsWith("@getexception/sentry-") &&
              !allowedDependency(name, target.split("/")[1]!)
            ) {
              errors.push(`Import: ${name} -> ${target}`);
            }

            if (
              ["browser", "react", "protocol"].includes(name) &&
              /^(node:|pg$|next|better-auth|@prisma)/.test(target)
            ) {
              errors.push(`Server import in client: ${path}`);
            }

            if (name === "ingest" && /better-auth|argon2|^next/.test(target)) {
              errors.push(`Auth in ingest: ${path}`);
            }

            if (
              ["web", "ingest"].includes(name) &&
              /worker|bullmq|redis/.test(target)
            ) {
              errors.push(`Background runtime: ${path}`);
            }
          }

          ts.forEachChild(node, visit);
        }

        visit(syntax);
      }
    }
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

if (process.argv[1]?.endsWith("architecture.ts")) {
  checkArchitecture();
  process.stdout.write("Workspace and runtime boundaries passed.\n");
}
