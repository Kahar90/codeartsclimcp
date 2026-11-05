// Contract check for runner/office-sprites.js (no browser): loads it in a bare vm context.
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../runner/office-sprites.js', import.meta.url), 'utf8');
const ctx = { window: {} }; vm.createContext(ctx);
const results = []; const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
let loadErr = ''; try { vm.runInContext(src, ctx, { filename: 'office-sprites.js' }); } catch (e) { loadErr = String(e); }
check('loads without DOM access', !loadErr, loadErr);
const S = ctx.window.OfficeSprites;
check('window.OfficeSprites exists', !!S && typeof S.draw === 'function');
if (S) {
  const roles = ['lead', 'builder', 'reviewer', 'fixer', 'idle'];
  check('roles list', Array.isArray(S.roles) && roles.every((r) => S.roles.includes(r)), JSON.stringify(S.roles));
  for (const r of roles) for (const state of ['working', 'idle']) {
    let svg = ''; try { svg = S.draw(r, { state, hue: 160 }); } catch (e) { svg = 'THROW ' + e; }
    const ok = typeof svg === 'string' && svg.trim().startsWith('<svg') && /viewBox=/.test(svg) && svg.length < 30000
      && (svg.match(/<svg\b/g) || []).length === (svg.match(/<\/svg>/g) || []).length
      && !/https?:\/\/(?!www\.w3\.org)/.test(svg) && !/<script/i.test(svg);
    check(`draw(${r}, ${state}) returns self-contained svg`, ok, ok ? `${svg.length} chars` : String(svg).slice(0, 80));
  }
  const w = S.draw('builder', { state: 'working', hue: 160 }); const i = S.draw('builder', { state: 'idle', hue: 160 });
  check('working differs from idle (animation)', w !== i);
  check('hue changes output', S.draw('builder', { state: 'working', hue: 20 }) !== w);
  check('deterministic', S.draw('reviewer', { state: 'working', hue: 90 }) === S.draw('reviewer', { state: 'working', hue: 90 }));
  check('working state animates', /@keyframes|<animate/.test(w));
  let unk = ''; try { unk = S.draw('nope', {}); } catch (e) { unk = 'THROW ' + e; }
  check('unknown role falls back to an svg', typeof unk === 'string' && unk.trim().startsWith('<svg'), String(unk).slice(0, 60));
  let noOpts = ''; try { noOpts = S.draw('lead'); } catch (e) { noOpts = 'THROW ' + e; }
  check('opts optional', typeof noOpts === 'string' && noOpts.trim().startsWith('<svg'));
  const a = S.draw('builder', { state: 'working' }); const b = S.draw('reviewer', { state: 'working' });
  const ids = (s) => [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check('ids unique across two sprites on one page', !ids(a).some((x) => ids(b).includes(x)) && new Set(ids(a)).size === ids(a).length);
}
console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
