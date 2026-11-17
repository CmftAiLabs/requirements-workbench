import {probeModel} from '../server/ai.ts';

// This is an explicit real model call. Ordinary tests use local fixtures instead.
const result = await probeModel();
console.log(result.message);
process.exitCode = result.ok ? 0 : 1;
