import { runBackendConformance } from "../src/conformance/suite.js";
import { MemoryBackend } from "../src/backend/memory.js";

runBackendConformance("MemoryBackend", () => new MemoryBackend());
