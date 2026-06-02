// esbuild `inject` shim: makes a single `browser` global available to every
// bundled entrypoint without each source file having to import the polyfill.
//
// esbuild replaces any free reference to `browser` in the bundled code with an
// import of this module's `browser` export, then tree-shakes it out of files
// that never touch it. On Firefox the polyfill detects the native promise-based
// `browser` and returns it unchanged; on Chrome it wraps `chrome.*` so the same
// `browser.*` (promise-based) calls work in both.
import browser from 'webextension-polyfill';

export { browser };
