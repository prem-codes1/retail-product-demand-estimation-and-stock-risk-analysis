'use strict';
// Gemini AI integration for demand forecast explanations.
// Uses Google Generative AI SDK (text generation only).

const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_RATE_LIMIT = 30; // requests per minute

// Simple in-memory token bucket rate limiter
class RateLimiter {
  constructor(requestsPerMinute = DEFAULT_RATE_LIMIT) {
    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60000; // tokens per ms
    this.lastRefill = Date.now();
  }

  tryConsume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  getRetryAfterMs() {
    this._refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }
}

// Build the prompt for demand forecast explanation
function buildExplanationPrompt(data) {
  const {
    productName,
    code,
    predictedDemand,
    currentStock,
    risk,
    features,
    history,
    nextWeek,
  } = data;

  // Format recent history for context (last 12 weeks)
  const recentHistory = history.slice(-12).map(w => w.demand);
  const historyStr = recentHistory.join(', ');

  // Calculate trend direction
  const trend4wk = features.rolling_mean_4 - features.rolling_mean_8;
  const trendDirection = trend4wk > 5 ? 'rising' : trend4wk < -5 ? 'falling' : 'stable';

  // Volatility assessment
  const cv = features.rolling_mean_4 > 0 ? features.rolling_std_4 / features.rolling_mean_4 : 0;
  const volatility = cv > 0.5 ? 'high' : cv > 0.25 ? 'moderate' : 'low';

  return `You are a supply chain analyst. Explain this demand forecast in plain English for a warehouse manager.

PRODUCT: ${productName} (${code})
FORECAST WEEK: ${nextWeek}
PREDICTED DEMAND: ${predictedDemand.toFixed(1)} units
CURRENT STOCK: ${currentStock} units
RISK LEVEL: ${risk}

KEY METRICS:
- Recent 4-week average: ${features.rolling_mean_4.toFixed(1)} units (trend: ${trendDirection})
- 8-week baseline average: ${features.rolling_mean_8.toFixed(1)} units
- Demand volatility: ${volatility} (4-week std dev: ${features.rolling_std_4.toFixed(1)})
- Last 4 weeks actual: ${features.lag_4}, ${features.lag_3}, ${features.lag_2}, ${features.lag_1}
- Current unit price: $${features.UnitPrice.toFixed(2)}
- Seasonality: Month ${features.month}, ISO Week ${features.week_of_year}

RECENT HISTORY (12 weeks): ${historyStr} units

INSTRUCTIONS:
- Write 3-4 sentences maximum
- Focus on actionable insights: why this forecast, what to watch
- Avoid technical ML jargon (no "features", "model", "trees")
- Be specific about drivers (price, seasonality, trend, volatility)
- Mention risk context if stock is low

OUTPUT FORMAT (JSON only, no markdown):
{
  "summary": "One-sentence executive summary of the forecast",
  "drivers": ["Specific driver 1", "Specific driver 2", "Specific driver 3"],
  "risks": ["Risk factor to monitor", "Another risk factor"],
  "confidence": "HIGH|MEDIUM|LOW"
}`;
}

// Parse and validate Gemini response
function parseExplanationResponse(text) {
  try {
    // Extract JSON from response (handle potential markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    const required = ['summary', 'drivers', 'risks', 'confidence'];
    for (const field of required) {
      if (!parsed[field]) throw new Error(`Missing field: ${field}`);
    }

    // Normalize confidence
    const validConfidence = ['HIGH', 'MEDIUM', 'LOW'];
    if (!validConfidence.includes(parsed.confidence.toUpperCase())) {
      parsed.confidence = 'MEDIUM';
    } else {
      parsed.confidence = parsed.confidence.toUpperCase();
    }

    // Ensure arrays
    parsed.drivers = Array.isArray(parsed.drivers) ? parsed.drivers.slice(0, 3) : [];
    parsed.risks = Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3) : [];

    // Truncate long strings
    parsed.summary = String(parsed.summary).slice(0, 300);
    parsed.drivers = parsed.drivers.map(d => String(d).slice(0, 150));
    parsed.risks = parsed.risks.map(r => String(r).slice(0, 150));

    return parsed;
  } catch (error) {
    console.warn('Failed to parse Gemini response:', error.message);
    return getFallbackExplanation();
  }
}

// Fallback explanation when Gemini fails
function getFallbackExplanation() {
  return {
    summary: 'AI explanation unavailable. Using statistical forecast based on recent trends.',
    drivers: ['Recent sales history', 'Seasonal patterns', 'Price levels'],
    risks: ['Forecast uncertainty', 'Demand volatility'],
    confidence: 'MEDIUM',
  };
}

class GeminiService {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    this.modelName = config.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.rateLimiter = new RateLimiter(config.rateLimit || Number(process.env.GEMINI_RATE_LIMIT) || DEFAULT_RATE_LIMIT);
    this.client = null;
    this.model = null;

    if (this.apiKey) {
      this.client = new GoogleGenerativeAI(this.apiKey);
      this.model = this.client.getGenerativeModel({ model: this.modelName });
    }
  }

  isConfigured() {
    return !!this.apiKey && !!this.model;
  }

  async generateExplanation(data) {
    if (!this.isConfigured()) {
      return {
        ...getFallbackExplanation(),
        generatedAt: new Date().toISOString(),
        source: 'fallback',
        note: 'GEMINI_API_KEY not configured',
      };
    }

    // Check rate limit
    if (!this.rateLimiter.tryConsume()) {
      const retryMs = this.rateLimiter.getRetryAfterMs();
      return {
        ...getFallbackExplanation(),
        generatedAt: new Date().toISOString(),
        source: 'rate_limited',
        note: `Rate limited. Retry after ${Math.ceil(retryMs / 1000)}s`,
        retryAfterMs: retryMs,
      };
    }

    const prompt = buildExplanationPrompt(data);

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      const explanation = parseExplanationResponse(text);

      return {
        ...explanation,
        generatedAt: new Date().toISOString(),
        source: 'gemini',
        model: this.modelName,
      };
    } catch (error) {
      console.error('Gemini API error:', error.message);
      return {
        ...getFallbackExplanation(),
        generatedAt: new Date().toISOString(),
        source: 'error',
        note: `API error: ${error.message}`,
      };
    }
  }

  // Health check endpoint
  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, configured: false, error: 'GEMINI_API_KEY not set' };
    }

    try {
      // Quick test with minimal prompt
      const result = await this.model.generateContent('Reply "ok"');
      return {
        ok: true,
        configured: true,
        model: this.modelName,
        latencyMs: 0 // would measure in real implementation
      };
    } catch (error) {
      return { ok: false, configured: true, error: error.message };
    }
  }
}

// Singleton instance
let geminiService = null;

function getGeminiService(config) {
  if (!geminiService) {
    geminiService = new GeminiService(config);
  }
  return geminiService;
}

function resetGeminiService() {
  geminiService = null;
}

module.exports = {
  GeminiService,
  getGeminiService,
  resetGeminiService,
  buildExplanationPrompt,
  parseExplanationResponse,
  getFallbackExplanation,
  RateLimiter,
  DEFAULT_MODEL,
  DEFAULT_RATE_LIMIT,
};