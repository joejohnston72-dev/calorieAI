// Must run before cloud.js (a deferred module) and the classic scripts: the
// promise the ARC account layer resolves once supabase-js has loaded.
window.arcReady = new Promise(r => { window.__arcResolve = r; });
