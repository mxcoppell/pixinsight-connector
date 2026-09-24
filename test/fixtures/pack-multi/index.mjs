// A pack split across its own tools/ and lib/ modules, the way a published pack is laid out, so the
// loader has to resolve the pack's relative imports. Used by test/pack-multi.test.mjs.
import { tools as echoTools } from './tools/echo.mjs';
import { tools as noteTools } from './tools/note.mjs';

export const apiVersion = 1;
export const name = 'multi';
export const version = '0.1.0';
export const tools = [...echoTools, ...noteTools];
