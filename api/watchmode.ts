import type { VercelRequest, VercelResponse } from '@vercel/node';

const WATCHMODE_BASE_URL = 'https://api.watchmode.com/v1';

/**
 * Server-side proxy for the WatchMode API.
 *
 * The API key lives in WATCHMODE_API_KEY (no VITE_ prefix) so it stays on the
 * server and never reaches the client bundle. Only the two operations the app
 * actually needs are exposed - this is deliberately not a passthrough proxy.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (error) {
    console.error('WATCHMODE: proxy request failed:', error);
    return res.status(502).json({ error: 'upstream request failed' });
  }
}
