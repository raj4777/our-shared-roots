import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ROOT, DIST, readApp, hashedAppCss } from './app-source.mjs';

const html = readApp('index.html');
const start = html.indexOf('    const MONTH_NAMES_SHORT');
const end = html.indexOf('\n    function showToast', start);
if (start < 0 || end < 0) {
  console.error('FAIL could not extract date helpers');
  process.exit(1);
}
const ctx = {};
vm.runInNewContext(html.slice(start, end), ctx);

const results = [];
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  results.push([ok ? 'PASS' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`]);
}
function parts(s) {
  const p = ctx.parseFlexibleDateParts(s);
  if (!p) return null;
  return { year: p.year, month: p.month, day: p.day, qualifier: p.qualifier || null };
}

check('DD/MM/YYYY Indian', parts('15/03/1990'), { year: 1990, month: 2, day: 15, qualifier: null });
check('DD-MM-YYYY Indian', parts('15-03-1990'), { year: 1990, month: 2, day: 15, qualifier: null });
check('DD.MM.YYYY', parts('15.03.1990'), { year: 1990, month: 2, day: 15, qualifier: null });
check('ambiguous 05/06/2007 is 5 June (Indian)', parts('05/06/2007'), { year: 2007, month: 5, day: 5, qualifier: null });
check('05/25/2007 falls back to US MDY', parts('05/25/2007'), { year: 2007, month: 4, day: 25, qualifier: null });
check('ISO unchanged', parts('1990-03-15'), { year: 1990, month: 2, day: 15, qualifier: null });
check('GEDCOM with ABT', parts('ABT 12 JAN 1900'), { year: 1900, month: 0, day: 12, qualifier: 'ABT' });
check('BEF qualifier', parts('BEF 12 JAN 1900'), { year: 1900, month: 0, day: 12, qualifier: 'BEF' });
check('AFT qualifier', parts('AFT JAN 1900'), { year: 1900, month: 0, day: null, qualifier: 'AFT' });
check('ABT numeric Indian', parts('ABT 25/01/1900'), { year: 1900, month: 0, day: 25, qualifier: 'ABT' });
check('format ABT keeps qualifier', ctx.formatDisplayDate('ABT 12 JAN 1900', 'short'), 'c. Jan 12 1900');
check('format BEF keeps qualifier', ctx.formatDisplayDate('BEF 12 JAN 1900', 'long'), 'before January 12 1900');
check('format AFT keeps qualifier', ctx.formatDisplayDate('AFT JAN 1900'), 'after Jan 1900');
check('format BET range', ctx.formatDisplayDate('BET 1900 AND 1910'), '1900–1910');
check('format Indian numeric', ctx.formatDisplayDate('15/03/1990', 'short'), 'Mar 15 1990');
check('year label ABT', ctx.extractYearLabel('ABT 12 JAN 1900'), 'c. 1900');
check('year label BEF', ctx.extractYearLabel('BEF 1900'), '<1900');
check('year label BET', ctx.extractYearLabel('BET 1900 AND 1910'), '1900–1910');
check('year label Indian', ctx.extractYearLabel('15-03-1990'), '1990');
check('age from Indian date', ctx.computeAgeYears('25/01/2000', '25/01/2020'), 20);
check('age not yet birthday', ctx.computeAgeYears('25/01/2000', '24/01/2020'), 19);

const fails = results.filter(r => r[0] === 'FAIL');
results.forEach(r => console.log(r.filter(Boolean).join(' | ')));
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
