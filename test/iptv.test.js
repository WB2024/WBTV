import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, classifyPlaylist, isYoutube, isUrl } from '../src/iptv.js';

const LIST = `#EXTM3U x-tvg-url="http://epg.example/guide.xml"
#EXTINF:-1 tvg-id="BBC1.uk" tvg-logo="http://l/bbc.png" group-title="News, UK",BBC News (UK)
#EXTVLCOPT:http-user-agent=Foo
http://a.example/bbc.m3u8
#EXTINF:-1 group-title="Music",Some, Radio
https://b.example/radio.m3u8

#EXTINF:-1,No Url Entry
# a comment
#EXTINF:-1 tvg-name="Named",
rtmp://c.example/live
`;

test('parseM3u reads names, groups, logos and ids', () => {
  const r = parseM3u(LIST);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { name: 'BBC News (UK)', group: 'News, UK', logo: 'http://l/bbc.png', tvgId: 'BBC1.uk', url: 'http://a.example/bbc.m3u8' });
  assert.equal(r[1].name, 'Some, Radio');               // commas in the display name survive
  assert.equal(r[2].name, 'Named');                     // falls back to tvg-name
  assert.equal(r[2].url, 'rtmp://c.example/live');
});

test('an entry without a URL is dropped, not glued to the next one', () => {
  const r = parseM3u('#EXTINF:-1,Orphan\n#EXTINF:-1,Real\nhttp://x/y.m3u8\n');
  assert.deepEqual(r.map((e) => e.name), ['Real']);
});

test('classifyPlaylist tells a channel list from a single HLS stream', () => {
  assert.equal(classifyPlaylist(LIST), 'list');
  assert.equal(classifyPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n'), 'stream');
  assert.equal(classifyPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n'), 'stream');
});

test('url helpers', () => {
  assert.ok(isUrl('https://x/y') && !isUrl('/mnt/x.m3u'));
  assert.ok(isYoutube('https://www.youtube.com/watch?v=abc') && isYoutube('https://youtu.be/abc') && !isYoutube('https://example.com/youtube.com/'));
});
