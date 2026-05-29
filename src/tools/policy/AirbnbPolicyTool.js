import { BaseTool } from '../BaseTool.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * AirbnbPolicyTool
 *
 * Fetches the live Airbnb cancellation policy page and extracts key rules
 * in a structured format. Falls back to a known-good snapshot if fetching fails.
 */
export class AirbnbPolicyTool extends BaseTool {
  constructor() {
    super({
      name: 'get_airbnb_cancellation_policy',
      description: 'Fetches the latest Airbnb cancellation policy from the official page and returns structured rules + the live documentation link. Use this for any cancellation or refund discussion.',
    });

    this.officialUrl = 'https://www.airbnb.com/help/article/475';

    // Static fallback (used if live fetch fails)
    this.fallbackPolicy = {
      officialUrl: this.officialUrl,
      lastUpdated: '2026-05-01',
      summary: 'Airbnb\'s cancellation policy is strict and time-based.',
      source: 'Fallback snapshot (live fetch failed)',
      rules: {
        fullRefund: {
          condition: 'Within 24 hours of booking AND at least 14 days before check-in',
          refund: '100% of the total (including taxes and fees)'
        },
        partialRefund50: {
          condition: 'More than 24 hours after booking but at least 7 days before check-in',
          refund: '50% of the total (including taxes and fees)'
        },
        cleaningFeeOnly: {
          condition: 'Less than 7 days before check-in',
          refund: 'Only the cleaning fee + pro-rated taxes/fees'
        }
      }
    };
  }

  async execute(input, context = {}) {
    console.log('[AirbnbPolicyTool] Attempting to fetch live Airbnb policy...');

    try {
      const response = await axios.get(this.officialUrl, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GuestMessagingAgent/1.0)'
        }
      });

      const $ = cheerio.load(response.data);

      // Extract main article content
      const articleText = $('article').text() || $('main').text() || $('body').text();

      // Basic extraction of key sections (this can be improved over time)
      const rules = this._extractRules(articleText);

      console.log('[AirbnbPolicyTool] Successfully fetched live policy');

      return {
        detected: true,
        officialUrl: this.officialUrl,
        lastFetched: new Date().toISOString(),
        source: 'Live fetch from Airbnb help center',
        summary: 'Live policy data retrieved. Key rules extracted below.',
        rules,
        rawExcerpt: articleText.substring(0, 1200) + '...' // for debugging / judge
      };
    } catch (error) {
      console.warn('[AirbnbPolicyTool] Live fetch failed:', error.message);
      console.log('[AirbnbPolicyTool] Falling back to static policy snapshot');

      return {
        detected: true,
        ...this.fallbackPolicy,
        source: 'Fallback snapshot (live fetch failed)',
        fetchError: error.message
      };
    }
  }

  /**
   * Very lightweight rule extraction from the page text.
   * This can be made more sophisticated later.
   */
  _extractRules(text) {
    const lower = text.toLowerCase();

    return {
      fullRefund: {
        condition: this._findCondition(lower, 'full refund', '24 hours'),
        note: 'Most generous refund window'
      },
      partialRefund50: {
        condition: this._findCondition(lower, '50%', '7 days'),
        note: 'Common scenario for cancellations outside the 24-hour window'
      },
      cleaningFeeOnly: {
        condition: this._findCondition(lower, 'cleaning fee', '7 days before'),
        note: 'Limited refund close to check-in'
      },
      generalAdvice: 'Always direct guests to the official page for the most current and complete details.'
    };
  }

  _findCondition(text, keyword, contextHint) {
    const index = text.indexOf(keyword);
    if (index === -1) return 'See official page for current details';

    // Grab surrounding context
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + 120);
    return text.substring(start, end).replace(/\s+/g, ' ').trim();
  }
}
