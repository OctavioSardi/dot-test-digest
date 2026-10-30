/** ~2,500 lines of vitest checkmarks plus a passing summary (CT-1 shape). */
export function vitestPassOutput(totalLines = 2500, passed = 240): string {
  const filler = Array.from(
    { length: Math.max(0, totalLines - 2) },
    (_, index) => ` ✓ tests/suite-${(index % 32) + 1}.spec.ts > case ${index} 2ms`,
  );
  return [...filler, " Test Files  32 passed (32)", `      Tests  ${passed} passed (${passed})`].join("\n");
}

/** `failures` identical cascade blocks, each with a 35-frame node_modules trace (CT-2 shape). */
export function vitestCascadeOutput(failures = 50, framesPerTest = 35): string {
  const blocks: string[] = [];
  for (let index = 0; index < failures; index += 1) {
    const frames = Array.from(
      { length: framesPerTest },
      (_, frame) => ` ❯ fn${frame} (node_modules/vitest/dist/chunk-${frame}.js:${frame + 1}:1)`,
    );
    blocks.push(
      [
        ` FAIL  tests/spec-${index % 10}.spec.ts > case ${index}`,
        "TypeError: token.split is not a function",
        " ❯ parseToken (src/auth/jwt.ts:28:19)",
        ...frames,
        "",
      ].join("\n"),
    );
  }
  return [...blocks, `      Tests  ${failures} failed (${failures})`].join("\n");
}

/** An unstructured build log with the root cause planted at `errorAt` (CT-4 shape). */
export function linkerLog(totalLines = 3200, errorAt = 2840): string {
  const lines = Array.from({ length: totalLines }, (_, index) => `[${index + 1}] build step ok`);
  lines[errorAt - 1] = "ld: library not found for -lpq";
  lines[errorAt] = "clang: error: linker command failed with exit code 1";
  return lines.join("\n");
}
