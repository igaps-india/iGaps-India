/**
 * Pitch deck parser abstraction — implementation pending upload pipeline integration.
 */

export interface PitchDeckTractionData {
  status: 'pending' | 'success' | 'unavailable';
  revenue?: string;
  users?: string;
  growth?: string;
  funding?: string;
  scrapedAt?: string;
  message?: string;
}

export interface PitchDeckParserClient {
  parsePitchDeck(filePath: string): Promise<PitchDeckTractionData>;
}

/** Stub until pitch deck parsing is integrated. */
export class PitchDeckParserStub implements PitchDeckParserClient {
  async parsePitchDeck(filePath: string): Promise<PitchDeckTractionData> {
    return {
      status: 'pending',
      message: `Pitch deck parsing not integrated. File: ${filePath}`,
      scrapedAt: new Date().toISOString(),
    };
  }
}

export const PITCH_DECK_SCRAPE_FILE = 'pitch_deck_traction.json';
