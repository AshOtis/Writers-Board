/* Writers Board: the achievements. Series count up in small steps early and wider later; nothing resets.
 * Rewards: { rest: n } rest days, { title }, { ring }, { bg }. */

const WB_CATS = ['Daily writing', 'Streaks', 'Words', 'Sprints', 'Craft', 'Feats of writing'];
const WB_POINTS = i => i < 4 ? 5 : i < 10 ? 10 : i < 15 ? 25 : 50;
const plural = (n, w) => `${wbFmt(n)} ${w}${n === 1 ? '' : 's'}`;

// [key, category, icon, stat, steps, name, description, rewards]
const WB_SERIES = [
  ['level', 'Daily writing', '🌳', 'level', [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 19],
    (t, s) => `Level ${t}`, (t, s) => `Reach a daily target of ${wbFmt(s.startTarget + (t - 1) * s.step)} words.`,
    { 4: { ring: 'ember' }, 5: { bg: 'dusk' }, 10: { title: 'the Prolific' } }],
  ['days', 'Daily writing', '📅', 'days', [1, 3, 5, 7, 10, 14, 21, 30, 40, 50, 60, 75, 90, 100, 125, 150, 200, 250, 300, 365, 500],
    t => plural(t, 'writing day'), t => `Write on ${plural(t, 'different day')}.`,
    { 30: { rest: 1 }, 365: { title: 'the Devoted' } }],
  ['hits', 'Daily writing', '🎯', 'hits', [1, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300],
    t => `On target ×${t}`, t => `Hit your daily target ${t === 1 ? 'once' : t + ' times'}.`,
    { 25: { rest: 1 }, 100: { title: 'the Reliable' } }],
  ['bonus', 'Daily writing', '✨', 'bonuses', [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    t => `Bonus hunter ×${t}`, t => `Earn ${plural(t, 'daily or weekly bonus')}.`.replace('bonuss', 'bonuses'),
    { 50: { rest: 1 } }],
  ['streak', 'Streaks', '🔥', 'bestStreak', [2, 3, 5, 7, 10, 14, 21, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 365],
    t => `${t}-day streak`, t => `Write ${t} days in a row (rest days count).`,
    { 7: { rest: 1 }, 30: { title: 'the Steadfast' }, 100: { rest: 2 }, 365: { title: 'the Unbroken' } }],
  ['words', 'Words', '📚', 'words', [500, 1000, 2500, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 75000, 90000, 100000, 125000, 150000, 200000, 250000],
    t => `${wbFmt(t)} words`, t => `Write ${wbFmt(t)} words in total.`,
    { 10000: { rest: 1 }, 25000: { ring: 'rose' }, 50000: { bg: 'north' }, 100000: { title: 'the Tireless' } }],
  ['day', 'Words', '⚡', 'bestDay', [500, 1000, 1500, 2500, 5000],
    t => `${wbFmt(t)} in a day`, t => `Write ${wbFmt(t)} words in one day.`, {}],
  ['lanterns', 'Sprints', '🏮', 'sessions', [1, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300],
    t => plural(t, 'Lantern session'), t => `Log ${plural(t, 'Lantern Focus session')} in your daily notes.`,
    { 10: { title: 'Lamplighter' }, 50: { rest: 1 } }],
  ['focus', 'Craft', '🕯️', 'focusH', [1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 500, 1000],
    t => `${plural(t, 'hour')} of focus`, t => `Spend ${plural(t, 'hour')} in Lantern focus sessions.`,
    { 10: { rest: 1 }, 50: { rest: 1 }, 100: { ring: 'lantern' }, 500: { rest: 2 }, 1000: { title: 'the Lantern-keeper' } }],
  ['crumbs', 'Craft', '↪️', 'breadcrumbs', [1, 5, 10, 25, 50, 100],
    t => `Breadcrumbs ×${t}`, t => `Leave a "start here" note for tomorrow ${t === 1 ? 'once' : t + ' times'}.`, {}],
  ['early', 'Craft', '🌅', 'early', [1, 5, 10, 25, 50, 100],
    t => `Early riser ×${t}`, t => `Start writing before 9am on ${plural(t, 'day')}.`, { 25: { rest: 1 } }],
];

// [id, category, icon, name, description, points, test(stats), reward, feat]
const WB_ONE_OFFS = [
  ['saddle', 'Streaks', '🐎', 'Back in the saddle', 'Write again after a week or more away.', 10, s => s.flags.saddle, null],
  ['midnight', 'Feats of writing', '🌙', 'After midnight', 'Write in the writing box between midnight and 4am.', 0, s => s.flags.midnight, null, 1],
  ['christmas', 'Feats of writing', '🎄', 'Christmas pages', 'Write on Christmas Day.', 0, s => s.flags.christmas, null, 1],
  ['newyear', 'Feats of writing', '🎆', 'First page of the year', 'Write on New Year’s Day.', 0, s => s.flags.newyear, null, 1],
  ['night', 'Feats of writing', '🌠', 'The long night', 'Write 10,000 words in one day.', 0, s => s.bestDay >= 10000, null, 1],
];

// Every achievement as one flat list: { id, cat, icon, name, desc, points, have, need, reward, feat, chain, tier }
function wbAchievements(stats, set) {
  const out = [];
  for (const [key, cat, icon, stat, steps, nm, ds, rw] of WB_SERIES) {
    steps.forEach((t, i) => out.push({ id: `${key}:${t}`, cat, icon, name: nm(t, set), desc: ds(t, set), points: WB_POINTS(i),
      have: stats[stat] || 0, need: t, met: (stats[stat] || 0) >= t, reward: rw[t] || null, chain: key, tier: i, tiers: steps.length }));
  }
  for (const [id, cat, icon, name, desc, points, test, reward, feat] of WB_ONE_OFFS)
    out.push({ id, cat, icon, name, desc, points, met: !!test(stats), reward, feat: !!feat });
  return out;
}

const WB_RINGS = { default: ['Aurora', '#ec4899', '#f97316'], ember: ['Ember', '#ef4444', '#f59e0b'], rose: ['Rose', '#f472b6', '#a855f7'], lantern: ['Lantern gold', '#f59e0b', '#fde68a'] };
const WB_BGS = { none: 'None', aurora: 'Static Aurora (live colours)', dusk: 'Dusk', north: 'Northern lights' };
function wbRewardText(r) {
  if (!r) return '';
  if (r.rest) return r.rest === 1 ? 'Rest day' : `${r.rest} rest days`;
  if (r.title) return `Title: ${r.title}`;
  if (r.ring) return `Ring colour: ${WB_RINGS[r.ring][0]}`;
  if (r.bg) return `Background: ${WB_BGS[r.bg]}`;
  return '';
}
