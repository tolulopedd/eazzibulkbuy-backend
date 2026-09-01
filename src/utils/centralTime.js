export const APP_TIME_ZONE = 'America/Winnipeg';

function getDateParts(date, timeZone = APP_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getDateTimeParts(date, timeZone = APP_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getTimeZoneOffsetMs(date, timeZone = APP_TIME_ZONE) {
  const parts = getDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, second, millisecond = 0 }, timeZone = APP_TIME_ZONE) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = getTimeZoneOffsetMs(new Date(localAsUtc), timeZone);
  const firstUtc = localAsUtc - firstOffset;
  const finalOffset = getTimeZoneOffsetMs(new Date(firstUtc), timeZone);
  return new Date(localAsUtc - finalOffset);
}

export function getCentralDateParts(date = new Date(), timeZone = APP_TIME_ZONE) {
  const parts = getDateParts(date, timeZone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

export function startOfCentralYear(date = new Date()) {
  const { year } = getCentralDateParts(date);
  return zonedDateTimeToUtc({ year, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
}

export function startOfCentralMonth(date = new Date()) {
  const { year, month } = getCentralDateParts(date);
  return zonedDateTimeToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0 });
}
