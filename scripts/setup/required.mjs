/** The keys every repo's `.github/agents/crew.json` must define. Shared by render.mjs (a run) and check.mjs (setup). */
export const CONFIG = '.github/agents/crew.json';
export const REQUIRED = ['product', 'commands.install', 'commands.format', 'commands.lint', 'commands.typecheck', 'commands.test', 'paths.source', 'paths.models', 'paths.tests', 'scout.port', 'scout.readyPath'];

/**
 * crew.json's text as `{ config }`, or `{ error }`: a `[CrewSetup]` line HQ shows as the failure (naming
 * merge conflict markers when that is why it doesn't parse), instead of a bare SyntaxError.
 */
export function parseConfig(text) {
  try {
    return { config: JSON.parse(text) };
  } catch (e) {
    const msg = e.message.replace(/\s+/g, ' ');
    const why = /^<<<<<<< /m.test(text) ? `it still has merge conflict markers (${msg})` : msg;
    return { error: `[CrewSetup] ${CONFIG} is not valid JSON: ${why}` };
  }
}

/** `a.b.c` in an object; undefined when any step is missing. */
export function lookupIn(object, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), object);
}
