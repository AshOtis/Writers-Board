/* Writers Board: finding daily notes and reading them. */

// Where daily notes live: the core Daily Notes plugin's settings, unless you set your own
function wbConfig(app, s) {
  let folder = s.folder || '', format = s.format || '', template = s.template || '';
  if (s.useCore !== false) {
    try {
      const o = app.internalPlugins.getPluginById('daily-notes').instance.options;
      if (o) { folder = o.folder || ''; format = o.format || ''; template = o.template || ''; }
    } catch (e) { /* core plugin off: our own settings */ }
  }
  return { folder: String(folder).replace(/^\/+|\/+$/g, ''), format: format || 'YYYY-MM-DD', template };
}
function wbPath(cfg, date) { return (cfg.folder ? cfg.folder + '/' : '') + window.moment(date).format(cfg.format) + '.md'; }

function wbDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function wbAdd(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function wbKey(d) { return window.moment(d).format('YYYY-MM-DD'); }
function wbFromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function wbWeekStart(d) { const x = wbDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function wbFmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: n < 10 && n % 1 ? 1 : 0 }); }

// Words: letters or digits, with apostrophes and hyphens inside words
function wbCount(text) { const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu); return m ? m.length : 0; }

// Split a note into: the writing section (under the heading), and everything else
function wbSplit(text, heading) {
  const t = String(text || '').replace(/\r\n/g, '\n'), h = heading.trim().toLowerCase();
  const lines = t.split('\n');
  const i = lines.findIndex(l => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === h);
  if (i < 0) return { found: false, before: t, body: '', after: '', level: 2 };
  const level = lines[i].match(/^#+/)[0].length;
  let j = i + 1;
  while (j < lines.length && !(new RegExp('^#{1,' + level + '}\\s').test(lines[j]))) j++;
  return { found: true, before: lines.slice(0, i + 1).join('\n'), body: lines.slice(i + 1, j).join('\n').replace(/^\n+|\n+$/g, ''), after: lines.slice(j).join('\n'), level };
}

// What a note tells us: the words that count, focus minutes and Lantern sessions
function wbRead(text, s) {
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  let focus = 0, sessions = 0;
  for (const m of body.matchAll(/Focused (\d+) min/g)) { focus += Number(m[1]); sessions++; }
  const sec = wbSplit(body, s.heading);
  let words;
  if (s.counts === 'section') words = wbCount(sec.body);
  else {
    // the whole note, without headings, tasks, focus logs, code and embeds
    const clean = body.replace(/```[\s\S]*?```/g, '').split('\n')
      .filter(l => !/^#{1,6}\s/.test(l.trim()) && !/^\s*[-*+]\s+\[.\]/.test(l) && !/Focused \d+ min|Parked thought/.test(l))
      .join('\n').replace(/!\[\[[^\]]*\]\]/g, '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/https?:\/\/\S+/g, '');
    words = wbCount(clean);
  }
  return { words, focus, sessions, section: sec };
}
