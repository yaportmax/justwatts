// Event line parser for the web build: a port of parse_line() in server/justwatts/events.py.
const T = '(\\d+(?::\\d\\d){1,2})', NUM = '(-?\\d+|-)';
const parseT = t => t.split(':').reduce((a, p) => a * 60 + +p, 0);
const int = v => (v == null || v === '-' || v === '?' || v === 'free') ? null : +v;
const P = [
  ['step_start', new RegExp(`^START step (\\d+)/(\\d+) ${T} @(\\d+|free)W$`), g => ({ step: +g[1], steps: +g[2], duration_s: parseT(g[3]), target_w: int(g[4]) })],
  ['step_end', new RegExp(`^END step (\\d+): avg (\\d+)W \\(tgt (\\d+)\\) \\| HR avg ${NUM} max ${NUM} end ${NUM} \\| cad (\\d+)$`),
    g => ({ step: +g[1], avg_w: +g[2], target_w: +g[3], hr_avg: int(g[4]), hr_max: int(g[5]), hr_end: int(g[6]), cadence: +g[7] })],
  ['ride_start', new RegExp(`^RIDE START (.*) \\| FTP (\\d+) \\| (?:(\\d+) steps, ${T}|free)$`), g => ({ name: g[1], ftp: +g[2], steps: int(g[3]), total_s: g[4] ? parseT(g[4]) : null })],
  ['ride_resumed', new RegExp(`^RIDE RESUMED after (reload|restart) at T\\+${T} \\((\\d+) samples kept\\)$`), g => ({ after: g[1], elapsed_s: parseT(g[2]), samples: +g[3] })],
  ['ride_end', new RegExp(`^RIDE END ${T}$`), g => ({ elapsed_s: parseT(g[1]) })],
  ['paused', /^PAUSED(?: \((stopped pedaling)\))?$/, g => ({ auto: !!g[1] })],
  ['resumed', /^RESUMED$/, () => ({})],
  ['edit', new RegExp(`^EDIT (insert|replace|delete|end|duration|rest) (.*) \\| (\\d+) steps, ${T}$`), g => ({ op: g[1], detail: `${g[1]} ${g[2]}`, steps: +g[3], total_s: parseT(g[4]) })],
  ['manual', /^MANUAL (\w+)(?: (.*))?$/, g => ({ action: g[1], detail: g[2] || '' })],
  ['workout_done', new RegExp(`^WORKOUT DONE at T\\+${T}, riding free until End$`), g => ({ elapsed_s: parseT(g[1]) })],
  ['course_done', new RegExp(`^COURSE DONE at T\\+${T}, riding on until End$`), g => ({ elapsed_s: parseT(g[1]) })],
];
export function parseLine(line, time = null) {
  const ev = { time, type: 'other', raw: line, text: line };
  for (const [type, rx, f] of P) { const g = rx.exec(line); if (g) return Object.assign(ev, { type }, f(g)); }
  return ev;
}
