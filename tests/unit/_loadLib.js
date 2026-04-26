import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, '..', '..', 'extension', 'src', 'lib.js');

const code = readFileSync(LIB_PATH, 'utf8');
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

export default sandbox.globalThis.PRDP_LIB;
