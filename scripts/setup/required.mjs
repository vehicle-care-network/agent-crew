/** The keys every repo's `.github/agents/crew.json` must define. Shared by render.mjs (a run) and check.mjs (setup). */
export const CONFIG = '.github/agents/crew.json';
export const REQUIRED = ['product', 'commands.install', 'commands.format', 'commands.lint', 'commands.typecheck', 'commands.test', 'paths.source', 'paths.models', 'paths.tests', 'scout.port', 'scout.readyPath'];

/** `a.b.c` in an object; undefined when any step is missing. */
export function lookupIn(object, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), object);
}
