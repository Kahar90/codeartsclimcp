const fs = require('fs');
const html = fs.readFileSync('runner/office.html', 'utf8');
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, total = 0;
while ((m = re.exec(html))) {
  const body = m[1];
  if (!body.trim()) continue;
  if (/\bsrc\s*=/.test(m[0])) continue;
  i++;
  const f = `.tmp_office_script_${i}.mjs`;
  fs.writeFileSync(f, body);
  total += body.length;
  console.log('extracted', f, body.length, 'bytes');
}
console.log('blocks', i, 'total', total);
