/* Writers Board: a daily writing box with a target that grows as you do, a forgiving streak,
 * and achievements that unlock rest days, titles and looks. Everything stays in your vault. */

const WB_VIEW = 'writers-board';
const WB_SET = {
  name: '', title: '', useCore: true, folder: '', format: '', template: '', subfolders: true,
  counts: 'note', heading: 'Writing', startTarget: 100, step: 50, maxTarget: 1000,
  ring: 'default', bg: 'none', bgGlow: 35, bgDim: 50, banners: true, sound: true, openOnStart: false, fadeLantern: true
};
const WB_STATE = {
  days: {}, target: null, win: [], processed: null, streak: 0, bestStreak: 0, restUsed: [], earned: {},
  bonuses: {}, startHere: null, crumbs: 0, flags: {}, ease: false, shown: {}, seeded: false, done: null
};
const WB_DEPTH = 3;
const WB_REST_CAP = 5;

class WritersBoard extends Plugin {
  async onload() {
    const raw = (await this.loadData()) || {};
    this.set = Object.assign({}, WB_SET, raw.settings || {});
    this.d = Object.assign({}, JSON.parse(JSON.stringify(WB_STATE)), raw.state || {});
    if (this.d.target == null) this.d.target = this.set.startTarget;
    this.banners = new WBBanners(this);
    this.registerView(WB_VIEW, leaf => new WBView(leaf, this));
    this.addRibbonIcon('pen-line', 'Open Writers Board', () => this.open());
    this.addCommand({ id: 'open', name: 'Open the board', callback: () => this.open() });
    this.addCommand({ id: 'achievements', name: 'Show achievements', callback: () => this.openAchievements() });
    this.addSettingTab(new WBSettings(this.app, this));

    // keep up when daily notes change (ours or yours)
    const touched = f => { if (f && f.path && this.isDaily(f.path)) this.soon(f.path); };
    const moved = f => { this.idx = null; touched(f); };
    this.registerEvent(this.app.vault.on('modify', touched));
    this.registerEvent(this.app.vault.on('create', moved));
    this.registerEvent(this.app.vault.on('delete', f => { this.idx = null; if (f && f.path && this.isDaily(f.path)) this.rescan(); }));
    this.registerEvent(this.app.vault.on('rename', moved));
    this.registerInterval(window.setInterval(() => this.tick(), 60 * 1000));   // a new day while Obsidian is open

    this.app.workspace.onLayoutReady(async () => {
      await this.rescan(true);
      if (this.set.openOnStart) this.open();
    });
  }

  onunload() { this.banners.clear(); }

  save() { clearTimeout(this.st); this.st = window.setTimeout(() => this.saveData({ settings: this.set, state: this.d }), 400); }
  saveNow() { clearTimeout(this.st); return this.saveData({ settings: this.set, state: this.d }); }

  views() { return this.app.workspace.getLeavesOfType(WB_VIEW).map(l => l.view).filter(v => v instanceof WBView); }
  redraw() { this.views().forEach(v => v.render()); }

  async open() {
    let leaf = this.app.workspace.getLeavesOfType(WB_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: WB_VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  openAchievements(cat) { new WBAchModal(this.app, this, cat).open(); }

  /* ---------- daily notes ---------- */
  cfg() { return wbConfig(this.app, this.set); }
  isDaily(path) { const c = this.cfg(); return path.endsWith('.md') && (!c.folder || path.startsWith(c.folder + '/')); }
  file(date) {
    const cfg = this.cfg(), f = this.app.vault.getAbstractFileByPath(wbPath(cfg, date));
    if (f && f.extension === 'md') return f;
    if (!this.set.subfolders || !cfg.folder) return null;
    return this.names(cfg).get(window.moment(date).format(cfg.format).split('/').pop()) || null;
  }
  // file name -> note, inside the daily notes folder only, at most WB_DEPTH folders down
  names(cfg) {
    const sig = cfg.folder + '|' + cfg.format;
    if (this.idx && this.idx.sig === sig) return this.idx.map;
    const map = new Map();
    const walk = (folder, depth) => {
      for (const c of folder.children || []) {
        if (c.children) { if (depth < WB_DEPTH) walk(c, depth + 1); }
        else if (c.extension === 'md' && !map.has(c.basename)) map.set(c.basename, c);
      }
    };
    const root = this.app.vault.getAbstractFileByPath(cfg.folder);
    if (root && root.children) walk(root, 0);
    this.idx = { sig, map };
    return map;
  }
  today() { return wbDay(new Date()); }

  /* ---------- reading the history ---------- */
  async readDay(date) {
    const f = this.file(date), k = wbKey(date);
    if (!f) { if (this.d.days[k]) { this.d.days[k].w = 0; this.d.days[k].f = 0; this.d.days[k].s = 0; } return null; }
    const r = wbRead(await this.app.vault.cachedRead(f), this.set);
    const rec = this.d.days[k] || (this.d.days[k] = {});
    rec.w = r.words; rec.f = r.focus; rec.s = r.sessions;
    return r;
  }

  // Read the last three years of daily notes, catch up on the days since we last looked, then check achievements
  async rescan(first) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const today = this.today();
      for (let i = 0; i < 1100; i++) await this.readDay(wbAdd(today, -i));
      for (const k of Object.keys(this.d.days)) if (!this.d.days[k].w && !this.d.days[k].f && !this.d.days[k].first) delete this.d.days[k];
      this.process();
      if (this.d.seeded && !this.d.winSeeded) this.seedWin();   // 1.0.0 installs started with an empty window
      if (!this.d.seeded) {
        const n = this.check(true);
        this.d.seeded = true; this.d.ease = false; this.d.target = this.set.startTarget; this.seedWin();
        if (n) new Notice(`Writers Board: welcome! You start with ${n} achievement${n === 1 ? '' : 's'} from the writing already in your daily notes.`, 8000);
      } else if (!first) this.check(false);
      this.save();
      this.redraw();
    } finally { this.scanning = false; }
  }

  // a daily note changed: re-read just that day
  soon(path) {
    if (this.selfSave && Date.now() - this.selfSave < 1500) return;   // our own save
    clearTimeout(this.ct);
    this.ct = window.setTimeout(async () => {
      const t = this.today(), key = wbKey(t), tf = this.file(t);
      if (tf && tf.path === path) {
        const before = (this.d.days[key] || {}).w || 0;
        await this.readDay(t);
        this.noteFirst(before);
        this.views().forEach(v => v.reloadBox());
        this.live();
      } else { await this.rescan(); }
    }, 600);
  }

  tick() {
    const k = wbKey(this.today());
    if (this.lastDay && this.lastDay !== k) { this.process(); this.check(false); this.save(); this.redraw(); }
    this.lastDay = k;
  }

  /* ---------- the rules ---------- */
  // the last six writing days before today, hit or not: what "5 of your last 7" looks back on
  seedWin() {
    const d = this.d, tk = wbKey(this.today());
    const keys = Object.keys(d.days).filter(k => k < tk && d.days[k].w > 0).sort().slice(-6);
    d.win = keys.map(k => d.days[k].w >= (d.days[k].t || d.target) ? 1 : 0);
    d.winSeeded = true;
  }

  restEarned() {
    const list = wbAchievements(this.stats(), this.set);
    return list.filter(a => this.d.earned[a.id] && a.reward && a.reward.rest).reduce((n, a) => n + a.reward.rest, 0);
  }
  restLeft() { return Math.max(0, Math.min(WB_REST_CAP, this.restEarned() - this.d.restUsed.length)); }
  levelOf(t) { return Math.max(1, Math.floor((t - this.set.startTarget) / this.set.step) + 1); }

  // Walk the finished days (up to yesterday) once each: streak, rest days, target hits and levels
  process() {
    const d = this.d, yesterday = wbKey(wbAdd(this.today(), -1));
    const keys = Object.keys(d.days).filter(k => d.days[k].w > 0).sort();
    let k = d.processed ? wbKey(wbAdd(wbFromKey(d.processed), 1)) : keys[0];
    if (!k) { d.processed = yesterday; return; }
    let lastWrote = d.lastWrote || null;
    while (k <= yesterday) {
      const rec = d.days[k], w = rec ? rec.w : 0;
      if (w > 0) {
        rec.t = rec.t || d.target;
        const hit = w >= rec.t;
        if (lastWrote && (wbFromKey(k) - wbFromKey(lastWrote)) / 864e5 >= 8) d.flags.saddle = true;
        lastWrote = k;
        d.streak++;
        d.win.push(hit ? 1 : 0);
        const last7 = d.win.slice(-7), hits = last7.reduce((a, b) => a + b, 0);
        if (!d.seeded) { /* history before the plugin: count it, but start everyone at the starting target */ }
        else if (hits >= 5 && d.target < this.set.maxTarget) { d.target = Math.min(this.set.maxTarget, d.target + this.set.step); d.win = []; d.ease = false; }
        else if (last7.length >= 7 && hits <= 2 && d.target > this.set.startTarget) d.ease = true;
      } else if (d.streak > 0 && d.seeded && this.restLeft() > 0) {
        d.restUsed.push(k); d.streak++;
      } else d.streak = 0;
      d.bestStreak = Math.max(d.bestStreak, d.streak);
      d.processed = k;
      k = wbKey(wbAdd(wbFromKey(k), 1));
    }
    d.lastWrote = lastWrote;
  }

  todayRec() { const k = wbKey(this.today()); return this.d.days[k] || (this.d.days[k] = { w: 0, f: 0, s: 0 }); }
  liveStreak() { return this.d.streak + (this.todayRec().w > 0 ? 1 : 0); }
  // would today's hit level you up from tomorrow?
  levelPending() {
    const w = this.todayRec().w; if (w <= 0 || this.d.target >= this.set.maxTarget) return false;
    return this.d.win.slice(-6).reduce((a, b) => a + b, 0) + (w >= this.d.target ? 1 : 0) >= 5;
  }

  stats() {
    const d = this.d, tk = wbKey(this.today());
    let words = 0, focus = 0, sessions = 0, days = 0, hits = 0, best = 0, early = 0;
    for (const [k, r] of Object.entries(d.days)) {
      words += r.w || 0; focus += r.f || 0; sessions += r.s || 0;
      if (r.w > 0) days++;
      best = Math.max(best, r.w || 0);
      if (r.first && r.first < '09:00') early++;
      if (k === tk ? r.w >= d.target : (r.t && r.w >= r.t)) hits++;
    }
    const t = d.days[tk] || { w: 0 };
    const flags = Object.assign({}, d.flags);
    if (t.w > 0 && d.lastWrote && (this.today() - wbFromKey(d.lastWrote)) / 864e5 >= 8) flags.saddle = true;
    flags.christmas = Object.keys(d.days).some(k => k.endsWith('-12-25') && d.days[k].w > 0);
    flags.newyear = Object.keys(d.days).some(k => k.endsWith('-01-01') && d.days[k].w > 0);
    const bonuses = Object.values(d.bonuses).reduce((n, a) => n + a.length, 0);
    return { words, focusH: focus / 60, sessions, days, hits, bestDay: best, early, breadcrumbs: d.crumbs, bonuses, flags,
      bestStreak: Math.max(d.bestStreak, this.liveStreak()), level: this.levelOf(d.target) + (this.levelPending() ? 1 : 0) };
  }
  points() {
    const list = wbAchievements(this.stats(), this.set);
    const a = list.filter(x => this.d.earned[x.id]).reduce((n, x) => n + x.points, 0);
    const b = Object.entries(this.d.bonuses).reduce((n, [, ids]) => n + ids.reduce((m, id) => m + (WB_BONUS[id] ? WB_BONUS[id][1] : 0), 0), 0);
    return a + b;
  }

  // Earn whatever is now met. Quiet on the first run, so old writing doesn't fire fifty banners.
  check(quiet) {
    const list = wbAchievements(this.stats(), this.set), today = wbKey(this.today()), fresh = [];
    for (const a of list) if (a.met && !this.d.earned[a.id]) { this.d.earned[a.id] = quiet ? 'before' : today; fresh.push(a); }
    if (!quiet) for (const a of fresh) {
      this.banners.show({ kind: 'ach', icon: a.icon, label: a.feat ? 'Feat of writing' : 'Achievement earned', name: a.name,
        sub: a.reward ? 'Unlocked: ' + wbRewardText(a.reward) : a.desc, points: a.points });
    }
    if (fresh.length) this.save();
    return fresh.length;
  }

  // the first words of the day: note the time (for "Write before 9am") and late-night writing
  noteFirst(before) {
    const rec = this.todayRec();
    if (before === 0 && rec.w > 0 && !rec.first) rec.first = window.moment().format('HH:mm');
    const h = new Date().getHours();
    if (rec.w > before && h < 4) this.d.flags.midnight = true;
  }

  // Today changed: bonuses, target and level banners, achievements, and the board
  live() {
    const d = this.d, key = wbKey(this.today()), rec = this.todayRec();
    const sh = d.shown[key] || (d.shown[key] = {});
    if (rec.w >= d.target && !sh.hit) {
      sh.hit = 1;
      this.banners.show({ kind: 'target', icon: '🎯', label: 'Daily target hit', name: `${wbFmt(d.target)} words today`,
        sub: `${this.liveStreak()}-day streak` });
    }
    if (this.levelPending() && !sh.level) {
      sh.level = 1;
      this.banners.show({ kind: 'target', icon: '🌳', label: 'Level up', name: `Level ${this.levelOf(d.target) + 1}`,
        sub: `From tomorrow your target is ${wbFmt(Math.min(this.set.maxTarget, d.target + this.set.step))} words` });
    }
    this.bonusCheck();
    this.check(false);
    for (const k of Object.keys(d.shown)) if (k < wbKey(wbAdd(this.today(), -3))) delete d.shown[k];
    this.save();
    this.views().forEach(v => v.update());
  }

  bonusCheck() {
    const d = this.d, key = wbKey(this.today()), rec = this.todayRec();
    const got = d.bonuses[key] || [];
    for (const [id, [label, pts, test]] of Object.entries(WB_BONUS)) {
      if (id === 'five') continue;
      if (!got.includes(id) && test(this, rec)) { got.push(id); this.banners.pop(label, pts); }
    }
    if (got.length) d.bonuses[key] = got;
    const wk = 'W' + wbKey(wbWeekStart(this.today()));
    if (!d.bonuses[wk] && WB_BONUS.five[2](this, rec)) { d.bonuses[wk] = ['five']; this.banners.pop(WB_BONUS.five[0], WB_BONUS.five[1]); }
  }
  writingDaysThisWeek() {
    let n = 0; const ws = wbWeekStart(this.today());
    for (let i = 0; i < 7; i++) { const r = this.d.days[wbKey(wbAdd(ws, i))]; if (r && r.w > 0) n++; }
    return n;
  }

  /* ---------- writing into today's note ---------- */
  async todayFile(create) {
    const t = this.today();
    let f = this.file(t);
    if (f || !create) return f;
    const cfg = this.cfg(), path = wbPath(cfg, t);
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    let text = '';
    if (cfg.template) {
      const tf = this.app.metadataCache.getFirstLinkpathDest(cfg.template, '') || this.app.vault.getAbstractFileByPath(cfg.template.replace(/\.md$/, '') + '.md');
      if (tf) {
        const m = window.moment(t);
        text = (await this.app.vault.read(tf))
          .replace(/{{\s*date\s*:\s*([^}]+?)\s*}}/g, (x, fmt) => m.format(fmt)).replace(/{{\s*date\s*}}/g, m.format(cfg.format))
          .replace(/{{\s*time\s*}}/g, window.moment().format('HH:mm')).replace(/{{\s*title\s*}}/g, m.format(cfg.format));
      }
    }
    this.selfSave = Date.now();
    return this.app.vault.create(path, text);
  }
  async writeSection(body) {
    const f = await this.todayFile(true), h = this.set.heading;
    this.selfSave = Date.now();
    await this.app.vault.process(f, text => {
      const sec = wbSplit(text, h);
      const block = body.trim() ? body.replace(/\s+$/, '') + '\n' : '';
      if (!sec.found) { const head = text.replace(/\s*$/, ''); return (head ? head + '\n\n' : '') + `## ${h}\n\n` + block; }
      return sec.before + '\n\n' + block + (sec.after ? '\n' + sec.after.replace(/^\n+/, '') : '');
    });
  }
}

// daily and weekly bonuses: [label, points, test]
const WB_BONUS = {
  beat: ['Beat yesterday', 2, (p, r) => { const y = p.d.days[wbKey(wbAdd(p.today(), -1))]; return y && y.w > 0 && r.w > y.w; }],
  early: ['Write before 9am', 2, (p, r) => r.w > 0 && r.first && r.first < '09:00'],
  over: ['25% over target', 3, (p, r) => r.w >= Math.ceil(p.d.target * 1.25)],
  five: ['Five writing days this week', 5, p => p.writingDaysThisWeek() >= 5]
};

/* ---------- the board ---------- */
class WBView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.r = {}; }
  getViewType() { return WB_VIEW; }
  getDisplayText() { return 'Writers Board'; }
  getIcon() { return 'pen-line'; }
  async onOpen() { this.render(); }
  async onClose() { if (this.pending) { clearTimeout(this.saveT); await this.flush(); } }

  paintBackground() {
    const host = this.containerEl, s = this.plugin.set;
    const bg = this.unlocked('bg').includes(s.bg) ? s.bg : 'none';
    for (const k of ['aurora', 'dusk', 'north']) host.toggleClass('wb-bg-' + k, bg === k);
    host.toggleClass('wb-bg-host', bg !== 'none');
    host.toggleClass('wb-fade-lantern', s.fadeLantern !== false);
    host.setCssProps({ '--wb-dim': String(s.bgDim / 100), '--wb-glow': String(s.bgGlow / 100) });
    const ring = WB_RINGS[this.unlocked('ring').includes(s.ring) ? s.ring : 'default'];
    host.setCssProps({ '--wb-r1': ring[1], '--wb-r2': ring[2] });
  }
  unlocked(kind) { return wbUnlocked(this.plugin, kind); }

  async render() {
    const p = this.plugin, d = p.d, el = this.contentEl;
    this.paintBackground();
    const focused = this.r.box && document.activeElement === this.r.box;
    if (focused) { this.update(); return; }        // never pull the page out from under your typing
    el.empty(); el.addClass('wb');
    this.r = {};
    const wrap = el.createDiv({ cls: 'wb-wrap' });

    // header
    const top = wrap.createDiv({ cls: 'wb-top' });
    const tl = top.createDiv();
    tl.createEl('h1', { text: 'Writers Board' });
    const sub = tl.createDiv({ cls: 'wb-sub' });
    sub.appendText(window.moment().format('dddd D MMMM'));
    const title = this.unlocked('title').includes(p.set.title) ? p.set.title : '';
    if (p.set.name || title) {
      sub.appendText(' · ' + (p.set.name || ''));
      if (title) { if (p.set.name) sub.appendText(', '); sub.createSpan({ cls: 'wb-title', text: title }); }
    }
    const stats = top.createDiv({ cls: 'wb-stats' });
    const stat = (cls, label) => { const s = stats.createDiv({ cls: 'wb-stat ' + cls }); const b = s.createEl('b'); s.createEl('small', { text: label }); return { s, b }; };
    this.r.sStreak = stat('is-hot', 'writing streak').b;
    this.r.sWeek = stat('', 'words this week').b;
    this.r.sAll = stat('', 'words all time').b;
    const ap = stat('is-ap', 'achievement points ›'); this.r.sAP = ap.b; ap.s.onclick = () => p.openAchievements();

    const grid = wrap.createDiv({ cls: 'wb-grid' });
    const left = grid.createDiv({ cls: 'wb-col' }), right = grid.createDiv({ cls: 'wb-col' });

    // the writing card
    const card = left.createDiv({ cls: 'wb-card wb-writecard' });
    const h = card.createEl('h2', { text: "Today's writing" });
    h.createSpan({ cls: 'wb-sp' });
    this.r.lantern = h.createSpan({ cls: 'wb-pill' });
    const sh = d.startHere;
    if (sh && sh.text && sh.date < wbKey(p.today())) {
      const b = card.createDiv({ cls: 'wb-bridge' });
      b.createEl('b', { text: '↪ Tomorrow, start here' + (sh.date === wbKey(wbAdd(p.today(), -1)) ? ' (you wrote this yesterday)' : ` (from ${window.moment(wbFromKey(sh.date)).format('D MMM')})`) });
      b.createSpan({ text: sh.text });
    }
    if (d.ease && d.target > p.set.startTarget) {
      const e = card.createDiv({ cls: 'wb-ease' });
      e.createSpan({ text: `A hard week? Your target can stay at ${wbFmt(d.target)} words, or ease back to ${wbFmt(d.target - p.set.step)}.` });
      e.createEl('button', { text: 'Stay' }).onclick = () => { d.ease = false; d.win = []; p.save(); this.render(); };
      e.createEl('button', { text: 'Ease back', cls: 'mod-cta' }).onclick = () => { d.target -= p.set.step; d.ease = false; d.win = []; p.save(); this.render(); };
    }
    const tg = card.createDiv({ cls: 'wb-target' });
    const ring = tg.createDiv({ cls: 'wb-ring' });
    const svg = wbSvg('svg', { width: 80, height: 80, viewBox: '0 0 80 80' }, ring);
    const defs = wbSvg('defs', {}, svg), lg = wbSvg('linearGradient', { id: 'wb-grad' }, defs);
    wbSvg('stop', { offset: '0', style: 'stop-color: var(--wb-r1)' }, lg); wbSvg('stop', { offset: '1', style: 'stop-color: var(--wb-r2)' }, lg);
    wbSvg('circle', { cx: 40, cy: 40, r: 34, class: 'wb-ring-bg' }, svg);
    this.r.arc = wbSvg('circle', { cx: 40, cy: 40, r: 34, class: 'wb-ring-arc', stroke: 'url(#wb-grad)', 'stroke-dasharray': '213.6', 'stroke-dashoffset': '213.6' }, svg);
    const n = ring.createDiv({ cls: 'wb-ring-n' }).createDiv();
    this.r.wc = n.createEl('b'); this.r.of = n.createEl('small');
    const lv = tg.createDiv({ cls: 'wb-lvl' });
    this.r.lvlT = lv.createDiv({ cls: 'wb-lvl-t' });
    this.r.lvlD = lv.createDiv({ cls: 'wb-lvl-d' });
    this.r.mini = lv.createDiv({ cls: 'wb-mini' });

    // what's already finished today sits above the box, read-only; "Write more" opens a fresh box under it
    this.r.page = card.createDiv({ cls: 'wb-page' });
    await this.paintBox(await this.loadSection());
    this.r.bar = card.createDiv({ cls: 'wb-bar' }).createEl('i');
    this.r.bonus = card.createDiv({ cls: 'wb-bonus' });
    const row = card.createDiv({ cls: 'wb-row' });
    this.r.near = row.createSpan();
    row.createSpan({ cls: 'wb-sp' });
    this.r.saved = row.createSpan({ cls: 'wb-small' });
    this.r.finish = row.createEl('button', { cls: 'mod-cta' });
    this.r.finish.onclick = () => this.r.box ? this.finish() : this.writeMore();
    this.paintFinish();

    // achievements card
    this.r.achCard = right.createDiv({ cls: 'wb-card' });
    this.achCard();
    // streak
    const sc = right.createDiv({ cls: 'wb-card' });
    const sh2 = sc.createEl('h2', { text: 'Streak' }); sh2.createSpan({ cls: 'wb-sp' }); sh2.createEl('small', { text: 'forgiving' });
    const st = sc.createDiv({ cls: 'wb-streak' });
    this.r.big = st.createDiv({ cls: 'wb-big' });
    const sd = st.createDiv();
    sd.createDiv({ cls: 'wb-small', text: 'Rest days banked, earned from achievements. A missed day uses one instead of ending your streak.' });
    this.r.rest = sd.createDiv({ cls: 'wb-rest' });
    // heatmap, under the streak
    const hc = right.createDiv({ cls: 'wb-card wb-heatcard' });
    hc.createEl('h2', { text: 'Last 16 weeks' });
    this.heat(hc.createDiv({ cls: 'wb-heat' }));

    this.update();
  }

  async loadSection() {
    const p = this.plugin, f = await p.todayFile(false);
    if (!f) return '';
    return wbSplit(await this.app.vault.read(f), p.set.heading).body;
  }

  // today's finished writing (from "Finish for today"), if any
  doneText() { const x = this.plugin.d.done; return x && x.date === wbKey(this.plugin.today()) ? x.text : ''; }
  // split the writing section into the finished part and the part still being written
  splitDone(body) {
    const done = this.doneText();
    if (!done) return { done: '', draft: body };
    const b = body.replace(/\s+$/, '');
    if (b.startsWith(done)) return { done, draft: b.slice(done.length).replace(/^\n+/, '') };
    // changed in the note itself: everything there now counts as finished
    this.plugin.d.done.text = b; this.plugin.save();
    return { done: b, draft: '' };
  }
  async paintBox(body) {
    const p = this.plugin, pg = this.r.page, { done, draft } = this.splitDone(body);
    pg.empty(); this.r.box = null;
    const open = !done || this.more || !!draft;
    if (done) {
      const c = pg.createDiv({ cls: 'wb-done' + (open ? ' is-more' : '') });
      c.createDiv({ cls: 'wb-done-h', text: open ? 'Finished earlier today' : '✓ Finished for today · saved in your daily note' });
      c.createDiv({ cls: 'wb-done-t', text: done });
    }
    if (open) {
      const box = this.r.box = pg.createEl('textarea', { cls: 'wb-box', attr: { placeholder: done ? 'Carry on. This goes under what you finished earlier.' : `Just write. No prompt, no rules. It saves into today's daily note under "${p.set.heading}".` } });
      box.value = draft;
      box.addEventListener('input', () => this.typed());
    }
    this.lastBox = null; this.other = null;
    this.paintFinish();
  }
  paintFinish() { if (this.r.finish) this.r.finish.setText(this.r.box ? 'Finish for today' : 'Write more'); }
  writeMore() { this.more = true; this.paintBox(this.doneText()).then(() => { this.update(); this.r.box && this.r.box.focus(); }); }
  async finish() {
    const p = this.plugin;
    clearTimeout(this.saveT); await this.flush();
    const text = this.fullText().replace(/\s+$/, '');
    if (text) { p.d.done = { date: wbKey(p.today()), text }; p.save(); }
    this.more = false;
    await this.paintBox(await this.loadSection());
    this.update();
    new WBFinishModal(this.app, p).open();
  }
  fullText() {
    const done = this.doneText(), draft = this.r.box ? this.r.box.value.replace(/\s+$/, '') : '';
    return done && draft ? done + '\n\n' + draft : done || draft;
  }

  // today's note was changed somewhere else: pick that up, unless you're typing here
  async reloadBox() {
    this.other = null;
    if (!this.r.page || (this.r.box && document.activeElement === this.r.box) || this.pending) return;
    await this.paintBox(await this.loadSection());
  }

  // typing: count live, save a moment after you pause
  typed() {
    const p = this.plugin, rec = p.todayRec(), before = rec.w;
    const words = wbCount(this.r.box.value);
    if (p.set.counts === 'section') rec.w = wbCount(this.fullText());
    else rec.w = Math.max(0, (this.other == null ? (this.other = Math.max(0, before - (this.lastBox || 0))) : this.other) + words);
    this.lastBox = words;
    p.noteFirst(before);
    this.pending = true;
    clearTimeout(this.saveT);
    this.saveT = window.setTimeout(() => this.flush(), 700);
    p.live();
  }
  async flush() {
    this.pending = false;
    if (!this.r.box) return;
    await this.plugin.writeSection(this.fullText());
    if (this.r.saved) this.r.saved.setText('Saved ' + window.moment().format('HH:mm'));
  }

  // refresh the numbers without rebuilding (keeps your cursor where it is)
  update() {
    const p = this.plugin, d = p.d, r = this.r, rec = p.todayRec();
    if (!r.wc) return;
    if (this.other == null) { this.lastBox = r.box ? wbCount(r.box.value) : 0; if (p.set.counts !== 'section') this.other = Math.max(0, rec.w - this.lastBox); }
    const w = rec.w, t = d.target, pr = Math.min(1, w / t);
    r.wc.setText(wbFmt(w)); r.of.setText('of ' + wbFmt(t));
    r.arc.setAttribute('stroke-dashoffset', String(213.6 * (1 - pr)));
    r.bar.setCssStyles({ width: pr * 100 + '%' });
    const lvl = p.levelOf(t);
    r.lvlT.empty(); r.lvlT.appendText('Target '); r.lvlT.createEl('em', { text: wbFmt(t) + ' words' }); r.lvlT.appendText(' · Level ' + lvl);
    const win = d.win.slice(-6), hits = win.reduce((a, b) => a + b, 0) + (w >= t ? 1 : 0);
    if (p.levelPending()) r.lvlD.setText(`Level ${lvl + 1} reached! From tomorrow your target is ${wbFmt(Math.min(p.set.maxTarget, t + p.set.step))} words.`);
    else if (t >= p.set.maxTarget) r.lvlD.setText(`You're at your ceiling of ${wbFmt(p.set.maxTarget)} words. Raise it in settings if you like.`);
    else if (win.reduce((a, b) => a + b, 0) >= 5) r.lvlD.setText(`You've hit 5 of your last 7 days. Write today and you reach Level ${lvl + 1} (${wbFmt(t + p.set.step)} words) tomorrow.`);
    else if (win.reduce((a, b) => a + b, 0) === 4) r.lvlD.setText(`Hit today's target and you reach Level ${lvl + 1} (${wbFmt(t + p.set.step)} words) tomorrow.`);
    else r.lvlD.setText(`Hit it on 5 of your last 7 writing days to reach Level ${lvl + 1} (${wbFmt(t + p.set.step)} words). You're on ${hits} of 7.`);
    r.lvlD.toggleClass('is-good', p.levelPending());
    r.mini.empty(); r.mini.appendText('Last 7 days ');
    const pips = d.win.slice(-6).concat([w >= t ? 1 : 0]);
    while (pips.length < 7) pips.unshift(-1);
    pips.forEach((x, i) => r.mini.createEl('i', { cls: (x === 1 ? 'is-hit' : '') + (i === 6 ? ' is-today' : '') }));
    r.mini.createSpan({ cls: 'wb-sep', text: '·' });
    const steps = [-2, -1, 0, 1].map(k => t + k * p.set.step).filter(v => v >= p.set.startTarget && v <= p.set.maxTarget);
    steps.forEach((v, i) => { if (i) r.mini.appendText(' → '); if (v === t) r.mini.createEl('b', { text: wbFmt(v) }); else r.mini.appendText(wbFmt(v)); });

    // bonuses
    r.bonus.empty();
    r.bonus.createEl('b', { text: "Today's bonuses" });
    const got = d.bonuses[wbKey(p.today())] || [];
    const y = d.days[wbKey(wbAdd(p.today(), -1))];
    const labels = { beat: y && y.w ? `Beat yesterday (${wbFmt(y.w)})` : 'Beat yesterday', early: 'Write before 9am', over: `25% over target (${wbFmt(Math.ceil(t * 1.25))})` };
    for (const id of ['beat', 'early', 'over']) {
      const c = r.bonus.createSpan({ cls: 'wb-bc' + (got.includes(id) ? ' is-done' : '') });
      c.createEl('i', { text: got.includes(id) ? '✓' : '' }); c.appendText(labels[id]); c.createEl('small', { text: '+' + WB_BONUS[id][1] });
    }
    const wk = p.writingDaysThisWeek();
    r.bonus.createSpan({ cls: 'wb-week' + (d.bonuses['W' + wbKey(wbWeekStart(p.today()))] ? ' is-done' : ''), text: `This week: write on 5 days · ${Math.min(5, wk)}/5` });

    // Lantern today
    r.lantern.setText(rec.s ? `● ${rec.s} Lantern session${rec.s === 1 ? '' : 's'} · ${rec.f} min` : '');
    r.lantern.toggle(!!rec.s);

    // closest achievement
    const list = wbAchievements(p.stats(), p.set);
    const near = list.filter(a => !a.met && a.need && !d.earned[a.id] && a.have > 0).sort((a, b) => b.have / b.need - a.have / a.need)[0];
    r.near.empty();
    if (near) { r.near.appendText('Closest achievement: '); r.near.createEl('b', { text: near.name }); r.near.appendText(` · ${wbFmt(near.have)} / ${wbFmt(near.need)}`); }

    // header
    r.sStreak.setText(`${p.liveStreak()} day${p.liveStreak() === 1 ? '' : 's'}`);
    let week = 0; const ws = wbWeekStart(p.today()); for (let i = 0; i < 7; i++) { const x = d.days[wbKey(wbAdd(ws, i))]; if (x) week += x.w || 0; }
    r.sWeek.setText(wbFmt(week));
    r.sAll.setText(wbFmt(Object.values(d.days).reduce((a, x) => a + (x.w || 0), 0)));
    r.sAP.setText(wbFmt(p.points()));
    r.big.setText(String(p.liveStreak()));
    r.rest.empty();
    const left = p.restLeft();
    for (let i = 0; i < WB_REST_CAP; i++) r.rest.createEl('i', { cls: i < left ? '' : 'is-empty' });
    const earnedNow = Object.keys(d.earned).length;
    if (earnedNow !== this.earnedSeen) { this.earnedSeen = earnedNow; this.achCard(); }
  }

  achCard() {
    const p = this.plugin, c = this.r.achCard; if (!c) return;
    c.empty();
    const h = c.createEl('h2', { text: 'Achievements' }); h.createSpan({ cls: 'wb-sp' });
    h.createEl('button', { text: 'View all ›' }).onclick = () => p.openAchievements();
    const list = wbAchievements(p.stats(), p.set);
    wbRecent(p, list, 3).forEach(a => wbRow(p, c, a, { compact: true }));
    if (!wbRecent(p, list, 1).length) c.createDiv({ cls: 'wb-small', text: 'Your first achievement is a few words away.' });
    const cats = c.createDiv({ cls: 'wb-cats' });
    const bar = (label, got, all, cat, cls) => {
      const b = cats.createDiv({ cls: 'wb-cb ' + (cls || '') });
      b.createEl('i').setCssStyles({ width: (all ? got / all * 100 : 0) + '%' });
      const s = b.createSpan(); s.createSpan({ text: label }); s.createEl('b', { text: `${got} / ${all}` });
      b.onclick = () => p.openAchievements(cat);
    };
    bar('Achievements earned', list.filter(a => p.d.earned[a.id]).length, list.length, 'Summary', 'is-all');
    for (const cat of WB_CATS) { const L = list.filter(a => a.cat === cat); bar(cat, L.filter(a => p.d.earned[a.id]).length, L.length, cat); }
  }

  heat(el) {
    const p = this.plugin, d = p.d, start = wbAdd(wbWeekStart(p.today()), -7 * 15);
    const vals = Object.values(d.days).map(x => x.w || 0).filter(Boolean).sort((a, b) => a - b);
    const q = f => vals.length ? vals[Math.floor((vals.length - 1) * f)] : 1;
    const steps = [q(0.25), q(0.5), q(0.8)];
    for (let i = 0; i < 112; i++) {
      const day = wbAdd(start, i), k = wbKey(day), w = (d.days[k] || {}).w || 0;
      let cls = '';
      if (day > p.today()) cls = 'is-future';
      else if (d.restUsed.includes(k)) cls = 'is-rest';
      else if (w > 0) cls = w <= steps[0] ? 'l1' : w <= steps[1] ? 'l2' : w <= steps[2] ? 'l3' : 'l4';
      el.createEl('i', { cls, attr: { title: `${window.moment(day).format('ddd D MMM')}: ${d.restUsed.includes(k) ? 'rest day' : wbFmt(w) + ' words'}` } });
    }
  }
}

/* ---------- achievement rows, shared by the board and the window ---------- */
function wbEarnedDate(p, a) { const e = p.d.earned[a.id]; return !e ? '' : e === 'before' ? 'earlier' : window.moment(wbFromKey(e)).format('D MMM'); }
function wbRecent(p, list, n) {
  return list.filter(a => p.d.earned[a.id]).sort((a, b) => {
    const x = p.d.earned[a.id], y = p.d.earned[b.id];
    if (x === y) return b.points - a.points;
    if (x === 'before') return 1; if (y === 'before') return -1;
    return x < y ? 1 : -1;
  }).slice(0, n);
}
function wbRow(p, parent, a, o) {
  o = o || {};
  const done = !!p.d.earned[a.id];
  const row = parent.createDiv({ cls: 'wb-ach' + (done ? '' : ' is-off') + (a.feat ? ' is-feat' : '') + (o.compact ? ' is-compact' : '') + (done && p.d.earned[a.id] === wbKey(p.today()) ? ' is-new' : '') });
  row.createDiv({ cls: 'wb-ach-ic', text: a.icon });
  const mid = row.createDiv({ cls: 'wb-ach-mid' });
  mid.createDiv({ cls: 'wb-ach-nm', text: a.name });
  mid.createDiv({ cls: 'wb-ach-ds', text: a.desc });
  if (a.reward && !o.compact) mid.createDiv({ cls: 'wb-ach-rw' + (done ? '' : ' is-lock'), text: (done ? 'Unlocked: ' : 'Reward: ') + wbRewardText(a.reward) });
  if (!done && a.need && !o.compact) {
    const pb = mid.createDiv({ cls: 'wb-pb' }); pb.createEl('i').setCssStyles({ width: Math.min(100, a.have / a.need * 100) + '%' });
    mid.createDiv({ cls: 'wb-pt', text: `${wbFmt(Math.min(a.have, a.need))} / ${wbFmt(a.need)}` });
  }
  if (o.chain) {
    const all = o.chain, pip = mid.createDiv({ cls: 'wb-pips' });
    all.forEach(t => pip.createEl('i', { cls: (p.d.earned[t.id] ? 'is-on' : '') + (t.id === a.id ? ' is-cur' : ''), attr: { title: t.name } }));
    pip.createSpan({ text: `${all.filter(t => p.d.earned[t.id]).length} of ${all.length} in this series` });
    const b = pip.createEl('button', { cls: 'wb-plus', text: o.open ? '−' : '+', attr: { 'aria-label': 'Show the whole series' } });
    b.onclick = o.onToggle;
  }
  if (done) row.createDiv({ cls: 'wb-ach-dt', text: wbEarnedDate(p, a) });
  if (!a.feat) row.appendChild(p.banners.shield(a.points, done ? '' : 'is-off'));
  return row;
}
function wbUnlocked(p, kind) {
  const list = wbAchievements(p.stats(), p.set).filter(a => p.d.earned[a.id] && a.reward && a.reward[kind]);
  const got = list.map(a => a.reward[kind]);
  if (kind === 'bg') return ['none', 'aurora'].concat(got);
  if (kind === 'ring') return ['default'].concat(got);
  return got;
}

/* ---------- the achievements window ---------- */
class WBAchModal extends Modal {
  constructor(app, plugin, cat) { super(app); this.p = plugin; this.cur = cat || 'Summary'; this.filt = 'all'; this.open_ = {}; this.q = ''; }
  onOpen() {
    this.modalEl.addClass('wb-ach-modal');
    const c = this.contentEl; c.empty();
    const head = c.createDiv({ cls: 'wb-whead' });
    head.createEl('h3', { text: 'Achievements' });
    const pts = head.createDiv({ cls: 'wb-wpts' }); pts.appendChild(this.p.banners.shield('★')); pts.createSpan({ text: wbFmt(this.p.points()) + ' points' });
    head.createSpan({ cls: 'wb-sp' });
    const q = head.createEl('input', { attr: { type: 'search', placeholder: 'Search' } });
    q.oninput = () => { this.q = q.value.trim().toLowerCase(); this.draw(); };
    const body = c.createDiv({ cls: 'wb-wbody' });
    this.side = body.createDiv({ cls: 'wb-side' }); this.main = body.createDiv({ cls: 'wb-main' });
    this.draw();
  }
  onClose() { this.contentEl.empty(); }
  draw() {
    const p = this.p, list = wbAchievements(p.stats(), p.set), earned = a => !!p.d.earned[a.id];
    this.side.empty();
    for (const cat of ['Summary'].concat(WB_CATS)) {
      const it = this.side.createDiv({ cls: cat === this.cur && !this.q ? 'is-on' : '' });
      it.createSpan({ text: cat });
      if (cat !== 'Summary') { const L = list.filter(a => a.cat === cat); it.createEl('small', { text: `${L.filter(earned).length}/${L.length}` }); }
      it.onclick = () => { this.cur = cat; this.q = ''; this.contentEl.querySelector('input').value = ''; this.draw(); };
    }
    const m = this.main; m.empty(); m.scrollTop = 0;
    if (this.q) {
      m.createEl('h4', { text: 'Search' });
      list.filter(a => (a.name + ' ' + a.desc).toLowerCase().includes(this.q)).slice(0, 60).forEach(a => wbRow(p, m, a));
      return;
    }
    if (this.cur === 'Summary') return this.summary(m, list);
    const f = m.createDiv({ cls: 'wb-filt' });
    for (const [k, l] of [['all', 'All'], ['done', 'Earned'], ['todo', 'Still to earn']]) {
      const b = f.createEl('button', { text: l, cls: this.filt === k ? 'is-on' : '' }); b.onclick = () => { this.filt = k; this.draw(); };
    }
    if (this.cur === 'Feats of writing') m.createEl('p', { cls: 'wb-small', text: 'Feats are rare and give no points, just bragging rights.' });
    const seen = new Set();
    for (const a of list.filter(x => x.cat === this.cur)) {
      if (!a.chain) { if (this.filt === 'all' || (this.filt === 'done') === earned(a)) wbRow(p, m, a); continue; }
      if (seen.has(a.chain)) continue; seen.add(a.chain);
      const tiers = list.filter(x => x.chain === a.chain);
      const show = this.filt === 'done' ? [...tiers].reverse().find(earned) : (tiers.find(t => !earned(t)) || tiers[tiers.length - 1]);
      if (!show || (this.filt === 'todo' && earned(show))) continue;
      const open = !!this.open_[a.chain];
      wbRow(p, m, show, { chain: tiers, open, onToggle: () => { this.open_[a.chain] = !open; this.draw(); } });
      if (open) { const s = m.createDiv({ cls: 'wb-series' }); tiers.forEach(t => wbRow(p, s, t)); }
    }
  }
  summary(m, list) {
    const p = this.p;
    const titles = wbUnlocked(p, 'title');
    const tb = m.createDiv({ cls: 'wb-titlebox' });
    tb.createSpan({ text: 'Your title' });
    const sel = tb.createEl('select', { cls: 'dropdown' });
    sel.createEl('option', { text: 'None', value: '' });
    titles.forEach(t => sel.createEl('option', { text: t, value: t }));
    sel.value = titles.includes(p.set.title) ? p.set.title : '';
    sel.onchange = () => { p.set.title = sel.value; p.save(); p.redraw(); };
    tb.createSpan({ cls: 'wb-small', text: titles.length ? 'Shown on your board.' : 'Earn titles from achievements, for example a 30-day streak.' });
    m.createEl('h4', { text: 'Unlocked for you' });
    const un = m.createDiv({ cls: 'wb-unl' });
    const groups = new Map();
    for (const a of list.filter(x => x.reward && !x.reward.title)) {
      const key = (p.d.earned[a.id] ? '1' : '0') + (a.reward.rest ? 'Rest day' : wbRewardText(a.reward));
      const g = groups.get(key) || { done: !!p.d.earned[a.id], text: a.reward.rest ? 'Rest day' : wbRewardText(a.reward), n: 0 };
      g.n += a.reward.rest || 1; groups.set(key, g);
    }
    [...groups.values()].sort((a, b) => b.done - a.done).forEach(g =>
      un.createSpan({ cls: g.done ? '' : 'is-lock', text: (g.done ? '✓ ' : '🔒 ') + g.text + (g.n > 1 ? ` ×${g.n}` : '') }));
    const rest = p.restLeft();
    m.createEl('p', { cls: 'wb-small', text: `Rest days in the bank: ${rest} of ${WB_REST_CAP}. Rings and backgrounds you've unlocked are in Writers Board settings.` });
    m.createEl('h4', { text: 'Recent' });
    const rec = wbRecent(p, list, 4);
    rec.forEach(a => wbRow(p, m, a));
    if (!rec.length) m.createEl('p', { cls: 'wb-small', text: 'Nothing yet. Write a few words and you will have your first one.' });
    m.createEl('h4', { text: 'Almost there' });
    list.filter(a => !p.d.earned[a.id] && a.need && a.have > 0).sort((a, b) => b.have / b.need - a.have / a.need).slice(0, 3).forEach(a => wbRow(p, m, a));
  }
}

/* ---------- finish for today ---------- */
class WBFinishModal extends Modal {
  constructor(app, plugin) { super(app); this.p = plugin; }
  onOpen() {
    const c = this.contentEl, p = this.p;
    this.setTitle('Nice work. Where will you start tomorrow?');
    c.createEl('p', { cls: 'wb-small', text: "One line, so tomorrow you don't face a blank page. It shows at the top of the board." });
    const inp = c.createEl('input', { cls: 'wb-next', attr: { type: 'text', placeholder: 'e.g. The letter is from her brother, not her husband.' } });
    if (p.d.startHere && p.d.startHere.date === wbKey(p.today())) inp.value = p.d.startHere.text;
    const row = c.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'Skip' }).onclick = () => this.close();
    const ok = row.createEl('button', { text: 'Save', cls: 'mod-cta' });
    const save = () => {
      const t = inp.value.trim();
      if (t) {
        const today = wbKey(p.today());
        if (!(p.d.startHere && p.d.startHere.date === today)) p.d.crumbs++;
        p.d.startHere = { date: today, text: t };
        p.check(false); p.save(); p.redraw();
        new Notice('Saved. See you tomorrow.');
      }
      this.close();
    };
    ok.onclick = save;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    window.setTimeout(() => inp.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

/* ---------- settings ---------- */
class WBSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, s = p.set;
    el.empty();
    const re = async () => { p.idx = null; p.d.days = {}; p.d.processed = null; p.d.streak = 0; p.d.win = []; await p.saveNow(); await p.rescan(); };

    new Setting(el).setName('Open when Obsidian starts').addToggle(t => t.setValue(s.openOnStart).onChange(v => { s.openOnStart = v; p.save(); }));
    new Setting(el).setName('Fade the rest during Lantern Focus').setDesc('While a Lantern Focus session is running, everything but Today\'s writing fades back. Hover to bring it back.')
      .addToggle(t => t.setValue(s.fadeLantern !== false).onChange(v => { s.fadeLantern = v; p.save(); p.redraw(); }));
    new Setting(el).setName('Your name').setDesc('Shown on the board with your title, for example "Sam, the Steadfast". Optional.')
      .addText(t => t.setValue(s.name).onChange(v => { s.name = v.trim(); p.save(); p.redraw(); }));

    new Setting(el).setName('Daily notes').setHeading();
    new Setting(el).setName('Use the Daily Notes settings').setDesc('Read the folder, date format and template from Obsidian\'s core Daily Notes plugin.')
      .addToggle(t => t.setValue(s.useCore !== false).onChange(v => { s.useCore = v; p.save(); this.display(); }));
    if (s.useCore === false) {
      new Setting(el).setName('Folder').addText(t => t.setPlaceholder('Daily Notes').setValue(s.folder).onChange(v => { s.folder = v.trim(); p.save(); }));
      new Setting(el).setName('Date format').addText(t => t.setPlaceholder('YYYY-MM-DD').setValue(s.format).onChange(v => { s.format = v.trim(); p.save(); }));
      new Setting(el).setName('Template').setDesc('Used when the writing box creates today\'s note.').addText(t => t.setPlaceholder('Templates/Daily').setValue(s.template).onChange(v => { s.template = v.trim(); p.save(); }));
    }
    new Setting(el).setName('Include subfolders').setDesc('Also find daily notes in folders inside the daily notes folder, such as an Archive (up to 3 folders deep).')
      .addToggle(t => t.setValue(s.subfolders).onChange(v => { s.subfolders = v; p.save(); }));
    new Setting(el).setName('What counts as writing').setDesc('The whole note (without headings, tasks and focus logs), or only what you write under the writing heading.')
      .addDropdown(d => d.addOptions({ note: 'The whole daily note', section: 'Only the writing section' }).setValue(s.counts).onChange(v => { s.counts = v; p.save(); }));
    new Setting(el).setName('Writing heading').setDesc('The writing box saves under this heading in today\'s note.')
      .addText(t => t.setValue(s.heading).onChange(v => { s.heading = v.trim() || 'Writing'; p.save(); }));
    new Setting(el).setName('Read my daily notes again').setDesc('After changing the settings above, count your history again. Achievements you have earned are kept.')
      .addButton(b => b.setButtonText('Recount').onClick(async () => { b.setDisabled(true); await re(); b.setDisabled(false); new Notice('Writers Board: recounted.'); }));

    new Setting(el).setName('Target').setHeading();
    new Setting(el).setName('Starting target').setDesc('Words a day at Level 1.')
      .addText(t => t.setValue(String(s.startTarget)).onChange(v => { const n = parseInt(v, 10); if (n > 0) { s.startTarget = n; p.save(); } }));
    new Setting(el).setName('Step').setDesc('How much the target grows each level.')
      .addText(t => t.setValue(String(s.step)).onChange(v => { const n = parseInt(v, 10); if (n > 0) { s.step = n; p.save(); } }));
    new Setting(el).setName('Ceiling').setDesc('The target never grows past this.')
      .addText(t => t.setValue(String(s.maxTarget)).onChange(v => { const n = parseInt(v, 10); if (n > 0) { s.maxTarget = n; p.save(); } }));
    new Setting(el).setName('Current target').setDesc(`Now ${wbFmt(p.d.target)} words (Level ${p.levelOf(p.d.target)}). Set it by hand if it doesn't feel right.`)
      .addText(t => t.setValue(String(p.d.target)).onChange(v => { const n = parseInt(v, 10); if (n > 0) { p.d.target = n; p.d.win = []; p.save(); p.redraw(); } }));

    new Setting(el).setName('Looks').setHeading();
    const rings = wbUnlocked(p, 'ring'), bgs = wbUnlocked(p, 'bg');
    new Setting(el).setName('Ring colour').setDesc('Unlock more with achievements.')
      .addDropdown(d => { for (const k of Object.keys(WB_RINGS)) d.addOption(k, WB_RINGS[k][0] + (rings.includes(k) ? '' : ' (locked)')); d.setValue(rings.includes(s.ring) ? s.ring : 'default').onChange(v => { if (!rings.includes(v)) { new Notice('Earn this one with an achievement first.'); d.setValue(s.ring); return; } s.ring = v; p.save(); p.redraw(); }); });
    new Setting(el).setName('Background').setDesc('Static Aurora follows the theme\'s live colours. Unlock more with achievements.')
      .addDropdown(d => { for (const k of Object.keys(WB_BGS)) d.addOption(k, WB_BGS[k] + (bgs.includes(k) ? '' : ' (locked)')); d.setValue(bgs.includes(s.bg) ? s.bg : 'none').onChange(v => { if (!bgs.includes(v)) { new Notice('Earn this one with an achievement first.'); d.setValue(s.bg); return; } s.bg = v; p.save(); p.redraw(); this.display(); }); });
    if (s.bg !== 'none') {
      if (s.bg === 'aurora') new Setting(el).setName('Glow').addSlider(sl => sl.setLimits(10, 100, 5).setValue(s.bgGlow).setDynamicTooltip().onChange(v => { s.bgGlow = v; p.save(); p.redraw(); }));
      new Setting(el).setName('Darken').setDesc('Keep the writing easy to read.').addSlider(sl => sl.setLimits(0, 90, 5).setValue(s.bgDim).setDynamicTooltip().onChange(v => { s.bgDim = v; p.save(); p.redraw(); }));
    }

    new Setting(el).setName('Celebrations').setHeading();
    new Setting(el).setName('Banners').setDesc('A banner when you hit your target or earn an achievement, and a small pop for bonuses. They show wherever you are in Obsidian.')
      .addToggle(t => t.setValue(s.banners).onChange(v => { s.banners = v; p.save(); }));
    new Setting(el).setName('Sound').setDesc('A soft chime with each banner.').addToggle(t => t.setValue(s.sound).onChange(v => { s.sound = v; p.save(); }));
    new Setting(el).setName('Try them').addButton(b => b.setButtonText('Show a banner').onClick(() => {
      p.banners.show({ kind: 'target', icon: '🎯', label: 'Daily target hit', name: `${wbFmt(p.d.target)} words today`, sub: 'This is what it looks like' });
      p.banners.show({ kind: 'ach', icon: '🏆', label: 'Achievement earned', name: 'Example', sub: 'Unlocked: Rest day', points: 10 });
      p.banners.pop('Beat yesterday', 2);
    }));
  }
}
