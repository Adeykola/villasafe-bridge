// Local scheduled rules. Each lane may carry schedule_json:
// [{ time: "06:00", action: "open" }, { time: "22:00", action: "close" }]
// The scheduler ticks every minute and triggers matching rules even when offline.
let timer = null;
let lastFiredKey = '';

function start(getLanes, runLocal, log) {
  stop();
  timer = setInterval(() => tick(getLanes, runLocal, log), 30_000);
  tick(getLanes, runLocal, log);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(getLanes, runLocal, log) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const stamp = `${now.toDateString()} ${hh}:${mm}`;
  if (stamp === lastFiredKey) return;
  const lanes = getLanes() || [];
  for (const lane of lanes) {
    const rules = Array.isArray(lane.schedule_json) ? lane.schedule_json : [];
    for (const rule of rules) {
      if (rule.time === `${hh}:${mm}`) {
        log?.(`[scheduler] firing ${rule.action} on ${lane.name}`);
        await runLocal(lane.id, rule.action);
      }
    }
  }
  lastFiredKey = stamp;
}

module.exports = { start, stop };