---
'@wyw-in-js/transform': patch
---

Report pipeline and evaluation telemetry through an observer, so that the transform, the cache and the eval broker no longer branch on whether telemetry is enabled. Without a registered reporter the observer does nothing; with one, the telemetry records keep their keys and values.
