import { runBackendConformance } from "../src/conformance/suite.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { CachedBackend } from "../src/cache/cached-backend.js";

runBackendConformance("MemoryBackend", () => new MemoryBackend());
runBackendConformance("CachedBackend(MemoryBackend)", () => new CachedBackend(new MemoryBackend()));
