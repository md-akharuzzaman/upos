/** Local calendar date as YYYY-MM-DD. */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Minutes east of UTC, as the API expects (Toronto in summer = -240). */
export function tz(d = new Date()) {
  return -d.getTimezoneOffset();
}
