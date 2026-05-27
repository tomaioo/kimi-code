---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Add an in-memory read-through cache to `BlobStore` so repeated rehydration avoids redundant disk reads.
