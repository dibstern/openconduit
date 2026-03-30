// Global test setup — suppress log output so test results aren't drowned
// in JSON log lines or console noise. Only "error" remains visible so
// critical failures are still surfaced.

// 1. Backend (pino) — set minimum level to "error".
import { setLogLevel } from "../src/lib/logger.js";

setLogLevel("error");

// 2. Frontend — silence console.debug/info/warn produced by stores and
//    createFrontendLogger. console.error is left untouched.
const noop = () => {};
console.debug = noop;
console.info = noop;
console.warn = noop;
