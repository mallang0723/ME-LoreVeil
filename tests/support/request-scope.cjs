'use strict';
// Callback hook runner: the continuation must execute inside AsyncLocalStorage.run,
// just as Fastify's preValidation chain does. No TCP listener is needed.
function requestHarness(register) {
  const hooks = new Map();
  const app = { addHook(name, fn) {
    const list = hooks.get(name) ?? [];
    list.push(fn);
    hooks.set(name, list);
  } };
  register(app);
  function finish(request, aborted = false) {
    for (const fn of hooks.get(aborted ? 'onRequestAbort' : 'onResponse') ?? []) {
      if (aborted) fn(request, () => {});
      else fn(request, {}, () => {});
    }
  }
  function run(fn, request = { id: 'same-client-id', routeOptions: { url: '/api/generate' } }) {
    return new Promise((resolve, reject) => {
      const list = hooks.get('preValidation') ?? [];
      let index = 0;
      function next(error) {
        if (error) { reject(error); return; }
        try {
          if (index < list.length) list[index++](request, {}, next);
          else Promise.resolve(fn(request)).then(resolve, reject).finally(() => finish(request));
        } catch (error) { finish(request); reject(error); }
      }
      next();
    });
  }
  return { run, finish, app };
}
module.exports = { requestHarness };
