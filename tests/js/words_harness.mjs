// stdin: ["text", ...] -> stdout: [{text: workout text} | {error, isError}]
// stdin: {texts: [...], timed: true} -> stdout: {results: [...], ms} (total time for all texts)
import { fromWords } from '../../app/js/words.js';
import { treeText } from '../../app/js/core.js';
let src = ''; for await (const c of process.stdin) src += c;
const req = JSON.parse(src), texts = Array.isArray(req) ? req : req.texts;
const read = t => { try { return { text: treeText(fromWords(t)) }; } catch (e) { return { error: String(e?.message ?? e), isError: e instanceof Error }; } };
const t0 = performance.now(), results = texts.map(read), ms = performance.now() - t0;
process.stdout.write(JSON.stringify(Array.isArray(req) ? results : { results, ms }));
