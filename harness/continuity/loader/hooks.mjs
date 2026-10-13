// SIS sources import siblings as "./x.js" (TypeScript NodeNext style). Under Node's own
// type stripping that file does not exist, so retry the same relative path as ".ts".
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith(".") || specifier.startsWith("file:");
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !relative || !specifier.endsWith(".js")) throw error;
    return next(`${specifier.slice(0, -3)}.ts`, context);
  }
}
