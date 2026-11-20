export function fakeClock() {
  let time = 0; let id = 0;
  const tasks = new Map(); const history = [];
  return {
    now: () => time,
    schedule(callback, delay) { const key = ++id; tasks.set(key, { callback, at: time + delay }); history.push(callback); return key; },
    cancel: (key) => tasks.delete(key),
    get count() { return tasks.size; },
    get callbacks() { return history; },
    tick(delay) {
      const end = time + delay;
      for (;;) {
        const first = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        time = first[1].at; tasks.delete(first[0]); first[1].callback();
      }
      time = end;
    },
  };
}
