/**
 * Formats an air date at whatever precision upstream actually knows.
 *
 * Air dates arrive as "2026", "2026-10", or a full timestamp. Rendering a partial date
 * through the Date constructor invents detail that isn't there - "2026" becomes 1 January,
 * which then displays as "Dec 31, 2025" west of UTC.
 *
 * Everything is formatted in UTC. These are calendar dates, not instants: formatting them
 * in the viewer's zone shifted every date a day earlier for anyone behind UTC, so a show
 * airing on the 23rd read as the 22nd.
 */
export const formatDate = (dateString?: string | null) => {
  if (!dateString) return 'TBA';

  if (/^\d{4}$/.test(dateString)) {
    return dateString;
  }

  const yearMonth = /^(\d{4})-(\d{2})$/.exec(dateString);
  if (yearMonth) {
    return new Date(Date.UTC(Number(yearMonth[1]), Number(yearMonth[2]) - 1, 1)).toLocaleDateString(
      'en-US',
      { year: 'numeric', month: 'short', timeZone: 'UTC' }
    );
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'TBA';

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
};

export const capitalizeFirstLetter = (string: string) => {
  return string.charAt(0).toUpperCase() + string.slice(1);
};

export const truncateText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}; 