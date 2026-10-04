---
'@wyw-in-js/transform': patch
---

Fall back to JSON parsing when Oxc cannot allocate its raw-transfer buffer, and keep using JSON for subsequent parses. This fixes builds failing with `Array buffer allocation failed` on systems with limited allocation capacity.

Report the switch through the parser debug namespace. Pipeline telemetry schema version 2 adds `rawTransferFallbackAttempts` and includes JSON retries in physical parser attempts and byte totals without inflating logical requests or errors.
