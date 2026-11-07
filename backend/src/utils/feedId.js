/**
 * Numeric feed id of an event (`items[].id` on GET /disasters), derived from the
 * source's own id so it is stable across refreshes and restarts.
 *
 * The id was a 32-bit base-31 string hash, which collides systematically on
 * USGS ids that share a prefix and differ in their last two characters
 * ("us7000twfu" and "us7000twh7": f·31+u = h·31+7): five pairs in one week's
 * feed, so two quakes shared an id, the list rendered wrong rows after paging
 * and a click could open the other event. This is cyrb53 (53-bit, a safe JSON
 * integer) over "<source>:<source id>", so the sources cannot collide with each
 * other either.
 */
export function feedId(source, sourceId) {
  const str = `${source}:${sourceId}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
