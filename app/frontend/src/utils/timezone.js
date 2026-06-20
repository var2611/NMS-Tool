/**
 * Timezone utilities.
 * All DB timestamps are UTC (no 'Z' suffix from Python).
 * We append 'Z' to force UTC parsing before converting to local time.
 */

/** Format a UTC ISO string in a given IANA timezone. */
export function formatTs(iso, timezone = 'UTC', style = 'datetime') {
  if (!iso) return '—'
  // Ensure the string is treated as UTC
  const utcIso = iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z'
  const date = new Date(utcIso)
  if (isNaN(date)) return iso

  const opts = { timeZone: timezone, hour12: false }

  if (style === 'time') {
    return new Intl.DateTimeFormat('en-GB', {
      ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date)
  }
  if (style === 'short') {
    return new Intl.DateTimeFormat('en-GB', {
      ...opts, month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(date)
  }
  return new Intl.DateTimeFormat('en-GB', {
    ...opts,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

/** Short HH:MM label for chart X-axes. */
export function chartLabel(iso, timezone = 'UTC') {
  if (!iso) return ''
  const utcIso = iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z'
  const date = new Date(utcIso)
  if (isNaN(date)) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

/** Curated timezone list for the Settings dropdown. */
export const TIMEZONE_LIST = [
  { group: 'UTC',              options: [{ value: 'UTC',                   label: 'UTC  (UTC+00:00)' }] },
  { group: 'Americas',        options: [
    { value: 'America/New_York',      label: 'Eastern Time        (UTC−05/−04)' },
    { value: 'America/Chicago',       label: 'Central Time         (UTC−06/−05)' },
    { value: 'America/Denver',        label: 'Mountain Time       (UTC−07/−06)' },
    { value: 'America/Los_Angeles',   label: 'Pacific Time          (UTC−08/−07)' },
    { value: 'America/Anchorage',     label: 'Alaska                  (UTC−09/−08)' },
    { value: 'America/Sao_Paulo',     label: 'São Paulo             (UTC−03/−02)' },
    { value: 'America/Toronto',       label: 'Toronto                 (UTC−05/−04)' },
    { value: 'America/Mexico_City',   label: 'Mexico City           (UTC−06/−05)' },
  ]},
  { group: 'Europe',          options: [
    { value: 'Europe/London',         label: 'London / Lisbon    (UTC+00/+01)' },
    { value: 'Europe/Paris',          label: 'Paris / Berlin       (UTC+01/+02)' },
    { value: 'Europe/Helsinki',       label: 'Helsinki                (UTC+02/+03)' },
    { value: 'Europe/Moscow',         label: 'Moscow                 (UTC+03:00)' },
  ]},
  { group: 'Africa & Middle East', options: [
    { value: 'Africa/Cairo',          label: 'Cairo                    (UTC+02:00)' },
    { value: 'Africa/Nairobi',        label: 'Nairobi                 (UTC+03:00)' },
    { value: 'Asia/Dubai',            label: 'Dubai / Abu Dhabi  (UTC+04:00)' },
    { value: 'Asia/Tehran',           label: 'Tehran                   (UTC+03:30)' },
    { value: 'Asia/Riyadh',           label: 'Riyadh                  (UTC+03:00)' },
  ]},
  { group: 'Asia',            options: [
    { value: 'Asia/Karachi',          label: 'Karachi                  (UTC+05:00)' },
    { value: 'Asia/Kolkata',          label: 'India (Kolkata)       (UTC+05:30)' },
    { value: 'Asia/Colombo',          label: 'Colombo                 (UTC+05:30)' },
    { value: 'Asia/Dhaka',            label: 'Dhaka                    (UTC+06:00)' },
    { value: 'Asia/Yangon',           label: 'Yangon                  (UTC+06:30)' },
    { value: 'Asia/Bangkok',          label: 'Bangkok / Jakarta   (UTC+07:00)' },
    { value: 'Asia/Singapore',        label: 'Singapore / KL       (UTC+08:00)' },
    { value: 'Asia/Shanghai',         label: 'China / HK / Taipei (UTC+08:00)' },
    { value: 'Asia/Tokyo',            label: 'Tokyo                     (UTC+09:00)' },
    { value: 'Asia/Seoul',            label: 'Seoul                     (UTC+09:00)' },
  ]},
  { group: 'Pacific & Oceania', options: [
    { value: 'Australia/Perth',       label: 'Perth                      (UTC+08:00)' },
    { value: 'Australia/Darwin',      label: 'Darwin                    (UTC+09:30)' },
    { value: 'Australia/Sydney',      label: 'Sydney / Melbourne  (UTC+10/+11)' },
    { value: 'Pacific/Auckland',      label: 'Auckland                  (UTC+12/+13)' },
    { value: 'Pacific/Honolulu',      label: 'Hawaii                     (UTC−10:00)' },
  ]},
]
