const { AsyncLocalStorage } = require("async_hooks");

/**
 * Per-request context, so every log line written while handling a request (from any file,
 * without passing anything around) carries the same requestId.
 */
const storage = new AsyncLocalStorage();

const run = (context, fn) => storage.run(context, fn);
const get = () => storage.getStore() ?? null;

module.exports = { run, get };
