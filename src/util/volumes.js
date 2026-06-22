// Pagination helper for daily_volumes range queries.
//
// PostgREST caps SELECT results at 1000 rows by default — silently. With
// ~47 active numbers, a single month easily exceeds that and the most
// recent days get truncated (History tab shows zeros for the last
// day(s), Slack/Reports under-count, invoices miss the tail). This
// helper pages through with .range() so the caller gets the full set
// regardless of how the project's max_rows is configured.
//
// Use everywhere we pull a month (or wider) range of daily_volumes.
// Single-date or .in('date', smallList) queries are safe without this.

export async function fetchVolumesInRange(sb, firstDay, lastDay) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('daily_volumes')
      .select('number_id, date, volume')
      .gte('date', firstDay).lte('date', lastDay)
      .order('date', { ascending: true })
      .order('number_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
