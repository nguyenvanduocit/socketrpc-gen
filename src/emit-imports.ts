import type { SourceFile } from "ts-morph";

/**
 * Adds type-only imports for every user-declared type referenced by the signatures.
 * The input file's imports are emitted before any dependency-file imports.
 */
export function addCustomTypeImports(
  sourceFile: SourceFile,
  usedTypes: Map<string, SourceFile>,
  inputFile: SourceFile,
): void {
  if (usedTypes.size === 0) return;

  const typesByFile = new Map<SourceFile, string[]>();
  for (const [name, sf] of usedTypes) {
    const bucket = typesByFile.get(sf);
    if (bucket) bucket.push(name);
    else typesByFile.set(sf, [name]);
  }

  const inputBucket = typesByFile.get(inputFile);
  const depBuckets = [...typesByFile.entries()].filter(([sf]) => sf !== inputFile);

  const emit = (sf: SourceFile, names: string[]) => {
    sourceFile.addImportDeclaration({
      moduleSpecifier: `./${sf.getBaseNameWithoutExtension()}`,
      namedImports: names,
      isTypeOnly: true,
    });
  };

  if (inputBucket) emit(inputFile, inputBucket);
  for (const [sf, names] of depBuckets) emit(sf, names);
}
