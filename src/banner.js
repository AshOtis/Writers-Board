// SVG without innerHTML
function wbSvg(tag, attrs, parent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}
/* Writers Board: banners that show anywhere in Obsidian, a quiet pop for bonuses, and a soft chime. */
class WBBanners {
  constructor(plugin) { this.p = plugin; this.q = []; this.busy = false; this.pq = []; this.pbusy = false; }

  chime(grand) {
    if (!this.p.set.sound) return;
    try {
      const C = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)()), t = C.currentTime;
      (grand ? [659, 880, 1319] : [523, 784]).forEach((f, i) => {
        const o = C.createOscillator(), g = C.createGain(), at = t + i * 0.12;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.1, at + 0.02); g.gain.exponentialRampToValueAtTime(0.001, at + 1.2);
        o.connect(g).connect(C.destination); o.start(at); o.stop(at + 1.3);
      });
    } catch (e) { /* no sound available */ }
  }

  shield(points, cls) {
    const el = createDiv({ cls: 'wb-shield ' + (cls || '') });
    const svg = wbSvg('svg', { viewBox: '0 0 40 44' }, el);
    wbSvg('path', { d: 'M20 2 L37 8 V22 C37 32 29 39 20 42 C11 39 3 32 3 22 V8 Z' }, svg);
    el.createSpan({ text: String(points) });
    return el;
  }

  // { kind: 'target' | 'ach', icon, label, name, sub, points }
  show(b) { if (!this.p.set.banners) return; this.q.push(b); if (!this.busy) this.next(); }
  next() {
    const b = this.q.shift();
    if (!b) { this.busy = false; return; }
    this.busy = true;
    const el = document.body.createDiv({ cls: 'wb-banner' + (b.kind === 'target' ? ' is-target' : '') });
    const fr = el.createDiv({ cls: 'wb-banner-frame' });
    fr.createDiv({ cls: 'wb-banner-sheen' });
    fr.createDiv({ cls: 'wb-banner-icon', text: b.icon });
    const tx = fr.createDiv({ cls: 'wb-banner-text' });
    tx.createDiv({ cls: 'wb-banner-label', text: b.label });
    tx.createDiv({ cls: 'wb-banner-name', text: b.name });
    if (b.sub) tx.createDiv({ cls: 'wb-banner-sub', text: b.sub });
    if (b.points != null && b.points > 0) fr.appendChild(this.shield(b.points));
    el.onclick = () => { this.p.openAchievements(); };
    window.requestAnimationFrame(() => el.addClass('is-on'));
    this.chime(b.kind !== 'target');
    window.setTimeout(() => this.sparks(fr), 250);
    window.setTimeout(() => { el.removeClass('is-on'); window.setTimeout(() => { el.remove(); this.next(); }, 500); }, b.kind === 'target' ? 2800 : 4200);
  }
  sparks(fr) {
    const r = fr.getBoundingClientRect();
    for (let i = 0; i < 24; i++) {
      const d = document.body.createDiv({ cls: 'wb-spark' });
      d.setCssStyles({ left: (r.left + Math.random() * r.width) + 'px', top: (r.top + r.height / 2) + 'px' });
      const a = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 120;
      d.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist}px)`, opacity: 0 }],
        { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => d.remove();
    }
  }

  // the quiet one, bottom right
  pop(text, points) { if (!this.p.set.banners) return; this.pq.push([text, points]); if (!this.pbusy) this.nextPop(); }
  nextPop() {
    const x = this.pq.shift();
    if (!x) { this.pbusy = false; return; }
    this.pbusy = true;
    const el = document.body.createDiv({ cls: 'wb-pop' });
    el.createSpan({ cls: 'wb-pop-tick', text: '✓' });
    el.createEl('b', { text: 'Bonus' });
    el.createSpan({ text: x[0] });
    el.createEl('small', { text: '+' + x[1] });
    window.requestAnimationFrame(() => el.addClass('is-on'));
    window.setTimeout(() => { el.removeClass('is-on'); window.setTimeout(() => { el.remove(); this.nextPop(); }, 450); }, 2400);
  }

  clear() { document.querySelectorAll('.wb-banner, .wb-pop, .wb-spark').forEach(e => e.remove()); }
}
