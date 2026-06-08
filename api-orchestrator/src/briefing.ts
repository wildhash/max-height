interface AgendaSignal {
  title: string;
  source: "calendar" | "email";
  urgency: "high" | "critical";
}

export interface DailyBriefingData {
  fetched_at: string | null;
  raw_agenda_summary: string;
  breaking_news_headlines: string[];
}

export interface BriefingPayload {
  fetchedAt: string;
  agendaSummary: string;
  breakingNewsHeadlines: string[];
  briefingText: string;
}

const NEWS_RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.reutersagency.com/feed/?best-sectors=technology",
];

function stripTags(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeadline(value: string): string {
  return stripTags(value).trim();
}

function parseRssTitles(xml: string): string[] {
  const titles = Array.from(xml.matchAll(/<item[\s\S]*?<title>([\s\S]*?)<\/title>/gi))
    .map((match) => normalizeHeadline(match[1] ?? ""))
    .filter((value) => value.length > 0);
  return [...new Set(titles)];
}

function summarizeAgenda(signals: AgendaSignal[]): string {
  if (signals.length === 0) {
    return "No urgent calendar collisions or vital unread emails were detected.";
  }

  const summary = signals
    .map((signal) => `${signal.source.toUpperCase()}: ${signal.title} [${signal.urgency}]`)
    .join(" | ");
  return `Priority agenda pressure: ${summary}`;
}

function createMockAgendaSignals(): AgendaSignal[] {
  return [
    {
      title: "Product launch stand-up overlaps focus block at 09:30",
      source: "calendar",
      urgency: "critical",
    },
    {
      title: "Unread investor escalation thread needs response before noon",
      source: "email",
      urgency: "high",
    },
  ];
}

async function fetchFeedHeadlines(feedUrl: string): Promise<string[]> {
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "max-height-briefing-bot/1.0" },
  });

  if (!response.ok) {
    throw new Error(`Failed RSS fetch: ${feedUrl} (${response.status})`);
  }

  const xml = await response.text();
  return parseRssTitles(xml);
}

async function fetchBreakingNewsHeadlines(maxCount = 6): Promise<string[]> {
  const settled = await Promise.allSettled(NEWS_RSS_FEEDS.map((feed) => fetchFeedHeadlines(feed)));
  const combined: string[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      combined.push(...result.value);
    }
  }

  const filtered = combined.filter((headline) =>
    /(ai|tech|technology|macro|economy|economic|chip|semiconductor|market|inflation)/i.test(
      headline,
    ),
  );
  const unique = [...new Set(filtered.length > 0 ? filtered : combined)];
  return unique.slice(0, maxCount);
}

export async function buildDailyBriefingPayload(): Promise<BriefingPayload> {
  const fetchedAt = new Date().toISOString();
  const agendaSummary = summarizeAgenda(createMockAgendaSignals());
  const headlines = await fetchBreakingNewsHeadlines().catch(() => [
    "Markets volatile as AI infrastructure spending accelerates across major cloud firms.",
    "Central banks hold rates steady while macro uncertainty keeps growth forecasts tight.",
    "Frontier model competition intensifies with new enterprise deployment race.",
  ]);

  const briefingText = [
    `Agenda: ${agendaSummary}`,
    `Breaking news: ${headlines.length > 0 ? headlines.join(" || ") : "No headline data available."}`,
  ].join("\n");

  return {
    fetchedAt,
    agendaSummary,
    breakingNewsHeadlines: headlines,
    briefingText,
  };
}
