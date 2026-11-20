---
'@wyw-in-js/transform': minor
---

Add an experimental host session API for bundler integrations: `createHostSession`, `createHostEngine`, `HostSessionClosedError` and their types. An integration opens one session per compiler or plugin instance. The session loads and normalizes the options once and keeps one evaluation cache key, one cache and one eval runner for all of its calls, so integrations no longer pass stable keys with each call. Each call returns a normalized output: code, CSS, resolved dependencies and warnings. `invalidate(files)` picks up edits of the config file and of `wyw-in-js.tags` in a `package.json` without a restart, and `close()` disposes the eval runner. `createHostEngine({ workers })` runs sessions in the worker pool, and keeps a session on the calling thread when a worker cannot take what it needs (functions in the options, a loader, an event emitter). The API is marked `@experimental`: it is meant for wyw-in-js integrations and may change in a minor release.

The `asyncResolveKey` and `evalBrokerScope` options of `transform()` are now marked `@deprecated` in favour of the host session. They keep working and print no warning.
