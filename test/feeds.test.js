'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, parseDuration, cleanText, Aggregator } = require('../lib/feeds');

const now = new Date();
const hoursAgo = (h) => new Date(now.getTime() - h * 3600e3).toUTCString();

const FEED = `<?xml version="1.0"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title><![CDATA[Daily News & Stuff]]></title>
  <atom:link href="https://example.com/feed.xml" rel="self"/>
  <link>https://example.com/show</link>
  <image><title>ignored</title><url>https://example.com/a.png</url></image>
  <item>
    <title>Morning &amp; evening: &#8220;quotes&#8221;</title>
    <link>https://example.com/ep1</link>
    <description><![CDATA[<p>Long article text that must never be exposed.</p>]]></description>
    <enclosure type="audio/mpeg" length="123" url="https://cdn.example.com/ep1.mp3?x=1&amp;y=2"/>
    <pubDate>${hoursAgo(1)}</pubDate>
    <guid>ep-1</guid>
    <itunes:duration>12:34</itunes:duration>
  </item>
  <item>
    <title>Video only</title>
    <enclosure url="https://cdn.example.com/v.mp4" type="video/mp4"/>
    <pubDate>${hoursAgo(2)}</pubDate>
  </item>
  <item>
    <title><![CDATA[No enclosure, text story]]></title>
    <link>https://example.com/text</link>
    <pubDate>${hoursAgo(2)}</pubDate>
  </item>
  <item>
    <title>Old one</title>
    <enclosure url='https://cdn.example.com/old.m4a'/>
    <pubDate>${hoursAgo(500)}</pubDate>
  </item>
  <item>
    <title>Second</title>
    <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg"/>
    <pubDate>${hoursAgo(3)}</pubDate>
    <itunes:duration>95</itunes:duration>
  </item>
  <item>
    <title>Bad scheme</title>
    <enclosure url="javascript:alert(1)" type="audio/mpeg"/>
    <pubDate>${hoursAgo(1)}</pubDate>
  </item>
</channel>
</rss>`;

test('parseFeed keeps only audio items, with title/link/audio and no text body', () => {
  const feed = parseFeed(FEED, { feed: 'https://example.com/feed.xml' });
  assert.equal(feed.title, 'Daily News & Stuff');
  assert.equal(feed.link, 'https://example.com/show');
  assert.deepEqual(feed.items.map((i) => i.title), ['Morning & evening: “quotes”', 'Old one', 'Second']);

  const [first] = feed.items;
  assert.equal(first.link, 'https://example.com/ep1');
  assert.equal(first.audio, 'https://cdn.example.com/ep1.mp3?x=1&y=2');
  assert.equal(first.type, 'audio/mpeg');
  assert.equal(first.duration, 754);
  assert.ok(first.id);
  assert.ok(!JSON.stringify(feed).includes('Long article text'));

  assert.equal(feed.items[1].link, 'https://example.com/show', 'falls back to channel link');
});

test('parseDuration and cleanText', () => {
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('360'), 360);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(cleanText('<![CDATA[ Hello <b>world</b> ]]>'), 'Hello world');
});

test('Aggregator applies freshness, per-source limit, source attribution and survives failures', async () => {
  const fetch = async (url) => {
    if (url.includes('broken')) throw new Error('boom');
    return { ok: true, status: 200, text: async () => FEED };
  };
  const agg = new Aggregator(
    [
      { name: 'Example', publisher: 'Example Media', feed: 'https://example.com/feed.xml', site: 'https://example.com/', limit: 5 },
      { name: 'Broken', feed: 'https://broken.example/feed.xml' },
      { name: 'Disabled', feed: 'https://example.com/feed.xml?d', enabled: false },
    ],
    { fetch, log: { info() {}, warn() {} } },
  );
  const items = await agg.refresh();
  assert.deepEqual(items.map((i) => i.title), ['Morning & evening: “quotes”', 'Second']);
  assert.equal(items[0].source, 'Example');
  assert.equal(items[0].publisher, 'Example Media');
  assert.equal(items[0].sourceUrl, 'https://example.com/');
  assert.ok(agg.updatedAt);

  const limited = new Aggregator([{ name: 'X', feed: 'https://example.com/feed.xml', limit: 1 }], { fetch, log: { info() {}, warn() {} } });
  assert.equal((await limited.refresh()).length, 1);
});
