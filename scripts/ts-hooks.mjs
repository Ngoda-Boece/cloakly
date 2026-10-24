// Permet aux scripts Node d'importer src/**/*.ts tel quel (imports sans extension, comme sous Vite).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
    return next(`${specifier}.ts`, context);
  }
}
