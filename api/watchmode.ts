const WATCHMODE_BASE_URL = 'https://api.watchmode.com/v1';

// Minimal structural types for the Vercel Node handler signature. Declared
// inline rather than imported from @vercel/node so this repo needs no extra
// dependency (and no lockfile churn) for a single file.
interface ProxyRequest {
  query: Record<string, string | string[] | undefined>;
}

interface ProxyResponse {
  status(code: number): ProxyResponse;
  json(body: unknown): ProxyResponse;
  setHeader(name: string, value: string): void;
}

/** A search with no matches, or a title with no known sources. */
function isEmptyResult(data: unknown): boolean {
  if (Array.isArray(data)) {
    return data.length === 0;
  }
  if (data && typeof data === 'object' && 'title_results' in data) {
    const results = (data as { title_results?: unknown }).title_results;
    return !Array.isArray(results) || results.length === 0;
  }
  return false;
}

/**
 * Server-side proxy for the WatchMode API.
 *
 * The API key lives in WATCHMODE_API_KEY (no VITE_ prefix) so it stays on the
 * server and never reaches the client bundle. Only the two operations the app
 * actually needs are exposed - this is deliberately not a passthrough proxy.
 */
export default async function handler(req: ProxyRequest, res: ProxyResponse) {
  const apiKey = process.env.WATCHMODE_API_KEY;
  if (!apiKey) {
    console.error('WATCHMODE: WATCHMODE_API_KEY is not set');
    return res.status(503).json({ error: 'WatchMode lookup is not configured' });
  }

  const { action, title, id } = req.query;

  let upstreamUrl: string;
  if (action === 'search') {
    if (typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'title is required' });
    }
    upstreamUrl = `${WATCHMODE_BASE_URL}/search/?apiKey=${apiKey}&search_field=name&search_value=${encodeURIComponent(title)}&types=tv`;
  } else if (action === 'sources') {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'numeric id is required' });
    }
    upstreamUrl = `${WATCHMODE_BASE_URL}/title/${id}/sources/?apiKey=${apiKey}&regions=US`;
  } else {
    return res.status(400).json({ error: 'unknown action' });
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl);

    if (!upstreamResponse.ok) {
      // Log the real status server-side; don't hand upstream auth failures to the client.
      console.error(`WATCHMODE: upstream responded ${upstreamResponse.status}`);
      return res.status(502).json({ error: 'upstream request failed' });
    }

    const data = await upstreamResponse.json();

    // Streaming availability changes on the order of weeks, so cache hits are held for a
    // day. Empty results are held briefly instead, so a title that becomes available shows
    // up without waiting out a long TTL.
    const maxAge = isEmptyResult(data) ? 3600 : 86400;
    res.setHeader('Cache-Control', `s-maxage=${maxAge}, stale-while-revalidate=604800`);
    return res.status(200).json(data);
  } catch (error) {
    console.error('WATCHMODE: proxy request failed:', error);
    return res.status(502).json({ error: 'upstream request failed' });
  }
}
