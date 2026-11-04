/**
 * Derives a Go import path from a module's go.mod.
 *
 * A separate Go client imports the types package the server is generated into,
 * so it needs that package's import path. Go spells it as the module path plus
 * the package directory relative to the module root, which is all this module
 * computes. It is pure: the caller finds and reads go.mod, so the derivation
 * runs in tests without a file system.
 */

import * as path from "path";

/** The module path a go.mod declares, or undefined when it declares none. */
export function goModulePath(goModSource: string): string | undefined {
  for (const line of goModSource.split("\n")) {
    const match = /^\s*module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/.exec(line);
    if (match) return match[2];
  }
  return undefined;
}

/**
 * The import path of the package in `packageDir`, for the module whose go.mod
 * sits in `moduleDir` and reads `goModSource`.
 *
 * Throws when go.mod declares no module or the package lies outside the module,
 * naming the flag that decides each.
 */
export function goImportPath(goModSource: string, moduleDir: string, packageDir: string): string {
  const modulePath = goModulePath(goModSource);
  if (modulePath === undefined) {
    throw new Error(`${path.join(moduleDir, "go.mod")} declares no module path.`);
  }
  const relative = path.relative(path.resolve(moduleDir), path.resolve(packageDir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `--go-out ${packageDir} is outside the Go module rooted at ${moduleDir}. Put --go-out inside that module.`,
    );
  }
  const posix = relative.split(path.sep).join("/");
  return posix ? `${modulePath}/${posix}` : modulePath;
}
