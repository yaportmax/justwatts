// stdin: ["text", ...] -> stdout: [{text: workout text} | {error}]
import { fromWords } from '../../app/js/words.js';
import { treeText } from '../../app/js/core.js';
let src = ''; for await (const c of process.stdin) src += c;
process.stdout.write(JSON.stringify(JSON.parse(src).map(t => { try { return { text: treeText(fromWords(t)) }; } catch (e) { return { error: e.message }; } })));
