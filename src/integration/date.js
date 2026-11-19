const koreanDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function koreaToday(now = Date.now()) {
  const parts = Object.fromEntries(koreanDate.formatToParts(new Date(now))
    .filter((part) => ['year', 'month', 'day'].includes(part.type))
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
