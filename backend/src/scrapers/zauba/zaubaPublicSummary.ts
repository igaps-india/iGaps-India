import * as cheerio from 'cheerio';

type CheerioRoot = ReturnType<typeof cheerio.load>;

const STOP_H3_PATTERNS = [
  'companies with similar address',
  'prosecution details',
  'charges (secured loans)',
  'contact details',
  'principal products',
  'balance sheet',
  'profit & loss',
  'fund raising',
  'subsidiaries',
  'board meetings',
  'auditors of',
  'update information',
];

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isLockedHeading(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.startsWith('purchase ') ||
    t.includes('payment system maintenance') ||
    t.includes('report is being processed') ||
    t === 'thank you' ||
    t.includes('lawsuit reports are currently under beta') ||
    t.includes('information required')
  );
}

function isStopH3(title: string): boolean {
  const t = title.toLowerCase();
  return STOP_H3_PATTERNS.some((p) => t.includes(p));
}

function isOtherDirectorshipsH4(title: string): boolean {
  return /^other directorships of /i.test(title.trim());
}

function isDirectorsH3(title: string): boolean {
  return title.toLowerCase().includes('directors & key managerial personnel');
}

function isCurrentOrPastDirectorsH4(title: string): boolean {
  return /current directors|past directors/i.test(title);
}

function isOtherDirectorshipsTable($: CheerioRoot, table: cheerio.Element): boolean {
  const headerLine = $(table)
    .find('tr')
    .first()
    .find('td, th')
    .map((_, c) => cleanText($(c).text()).toLowerCase())
    .get()
    .join(' ');
  return (
    headerLine.includes('company name') &&
    headerLine.includes('cin') &&
    headerLine.includes('designation') &&
    !headerLine.includes('director name') &&
    !headerLine.includes('din')
  );
}

function isDirectorsOfCompanyTable($: CheerioRoot, table: cheerio.Element): boolean {
  const headerLine = $(table)
    .find('tr')
    .first()
    .find('td, th')
    .map((_, c) => cleanText($(c).text()).toLowerCase())
    .get()
    .join(' ');
  return headerLine.includes('din') && headerLine.includes('director name');
}

function formatTable($: CheerioRoot, table: cheerio.Element): string {
  if (isOtherDirectorshipsTable($, table)) return '';

  const lines: string[] = [];
  $(table)
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr)
        .find('td, th')
        .map((__, c) => cleanText($(c).text()))
        .get()
        .filter(Boolean);
      if (cells.length > 0) lines.push(cells.join('\t'));
    });
  return lines.join('\n');
}

function extractAsOnDate($: CheerioRoot): string | undefined {
  const match = cleanText($('body').text()).match(/As on:\s*(\d{4}-\d{2}-\d{2})/i);
  return match?.[1];
}

function extractNarrativeBlocks($: CheerioRoot, targetCin: string): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>();

  $('p, div').each((_, el) => {
    const t = cleanText($(el).text());
    if (
      t.includes(targetCin) &&
      t.includes('incorporated on') &&
      t.length > 150 &&
      t.length < 4000 &&
      !seen.has(t)
    ) {
      seen.add(t);
      blocks.push(t);
    }
  });

  return blocks;
}

function directorBlockTitle(divText: string): string {
  const markers = [' DIN ', ' Company Name '];
  for (const m of markers) {
    const idx = divText.indexOf(m);
    if (idx > 0) return divText.slice(0, idx).trim();
  }
  return divText.slice(0, 100);
}

function processDirectorsSection($: CheerioRoot, h3: cheerio.Element, lines: string[]): void {
  const scope = $(h3).parent();

  scope.find('div.table-responsive').each((_, div) => {
    const probe = cleanText($(div).text());
    if (/other directorships of/i.test(probe)) return false;

    if (!/current directors|past directors/i.test(probe)) return;

    const table = $(div).find('table').first()[0];
    if (!table || !isDirectorsOfCompanyTable($, table)) return;

    lines.push('');
    lines.push(directorBlockTitle(probe));
    const tableText = formatTable($, table);
    if (tableText) {
      lines.push('');
      lines.push(tableText);
    }
  });
}

function processStandardSection($: CheerioRoot, h3: cheerio.Element, lines: string[]): void {
  $(h3)
    .nextUntil('h3')
    .each((_, node) => {
      const $node = $(node);

      if ($node.is('h4')) {
        const h4Title = cleanText($node.text());
        if (isLockedHeading(h4Title) || isOtherDirectorshipsH4(h4Title)) return false;
        lines.push('');
        lines.push(h4Title);
        return;
      }

      if ($node.is('table')) {
        const tableText = formatTable($, node);
        if (tableText) {
          lines.push('');
          lines.push(tableText);
        }
        return;
      }

      if ($node.is('p')) {
        const t = cleanText($node.text());
        if (t && !isLockedHeading(t) && !/^purchase /i.test(t)) lines.push(t);
        return;
      }

      $node.find('h4').each((__, h4) => {
        const h4Title = cleanText($(h4).text());
        if (isLockedHeading(h4Title) || isOtherDirectorshipsH4(h4Title)) return false;
        lines.push('');
        lines.push(h4Title);
      });

      $node.find('table').each((__, table) => {
        if (isOtherDirectorshipsTable($, table)) return;
        const tableText = formatTable($, table);
        if (tableText) {
          lines.push('');
          lines.push(tableText);
        }
      });

      $node.find('p').each((__, p) => {
        const t = cleanText($(p).text());
        if (t && !isLockedHeading(t) && !/^purchase /i.test(t) && t.length > 20) lines.push(t);
      });
    });
}

export function buildPublicZaubaSummary(html: string, cin: string): string {
  const targetCin = cin.toUpperCase();
  const $ = cheerio.load(html);

  if (!html.toUpperCase().includes(targetCin)) {
    throw new Error(`Page does not contain CIN ${targetCin}`);
  }

  const companyName = cleanText($('h1').first().text()) || 'Unknown Company';
  const asOn = extractAsOnDate($);
  const lines: string[] = [];

  lines.push(companyName);
  if (asOn) lines.push(`As on: ${asOn}`);
  lines.push('');

  for (const block of extractNarrativeBlocks($, targetCin)) {
    lines.push(block);
    lines.push('');
  }

  $('h3').each((_, h3) => {
    const title = cleanText($(h3).text());
    if (!title || isStopH3(title)) return false;

    lines.push(title);

    if (isDirectorsH3(title)) {
      processDirectorsSection($, h3, lines);
      lines.push('');
      return false;
    }

    processStandardSection($, h3, lines);
    lines.push('');
  });

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
