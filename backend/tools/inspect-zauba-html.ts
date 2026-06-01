import * as cheerio from 'cheerio';
import { fetchZaubaHtml } from '../src/scrapers/zauba/zaubaScraper';

fetchZaubaHtml('U93000DL2015PTC282802').then(({ html }) => {
  const $ = cheerio.load(html);
  const directorsH3 = $('h3')
    .filter((_, el) => $(el).text().toLowerCase().includes('directors & key'))
    .first();

  directorsH3.parent().find('div, table').each((i, el) => {
    if (i > 40) return false;
    const tag = $(el).prop('tagName');
    const cls = $(el).attr('class') ?? '';
    const text = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 80);
    console.log(i, tag, cls.slice(0, 30), text);
  });
});
