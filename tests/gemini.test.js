'use strict';
// Tests for Gemini integration

const { buildExplanationPrompt, parseExplanationResponse, RateLimiter, getFallbackExplanation } = require('../lib/gemini');

function testBuildPrompt() {
  const data = {
    productName: 'TEST PRODUCT',
    code: 'TEST001',
    predictedDemand: 100.5,
    currentStock: 50,
    risk: 'HIGH RISK',
    features: {
      lag_1: 90,
      lag_2: 95,
      lag_3: 100,
      lag_4: 105,
      rolling_mean_4: 97.5,
      rolling_mean_8: 95,
      rolling_std_4: 6.45,
      UnitPrice: 2.5,
      month: 12,
      week_of_year: 50,
    },
    history: Array.from({ length: 12 }, (_, i) => ({ demand: 90 + i })),
    nextWeek: '2011-12-12',
  };

  const prompt = buildExplanationPrompt(data);

  // Check key elements are in prompt
  console.assert(prompt.includes('TEST PRODUCT'), 'Product name in prompt');
  console.assert(prompt.includes('TEST001'), 'Product code in prompt');
  console.assert(prompt.includes('100.5'), 'Predicted demand in prompt');
  console.assert(prompt.includes('HIGH RISK'), 'Risk level in prompt');
  console.assert(prompt.includes('97.5'), 'Rolling mean in prompt');
  console.assert(prompt.includes('JSON only'), 'JSON format instruction in prompt');

  console.log('buildExplanationPrompt test passed');
}

function testParseResponse() {
  // Valid response
  const validResponse = `{
    "summary": "Test summary",
    "drivers": ["Driver 1", "Driver 2"],
    "risks": ["Risk 1"],
    "confidence": "HIGH"
  }`;
  const parsed = parseExplanationResponse(validResponse);
  console.assert(parsed.summary === 'Test summary', 'Summary parsed');
  console.assert(parsed.drivers.length === 2, 'Drivers parsed');
  console.assert(parsed.risks.length === 1, 'Risks parsed');
  console.assert(parsed.confidence === 'HIGH', 'Confidence parsed');

  // Response with markdown code block
  const markdownResponse = `\`\`\`json\n${validResponse}\n\`\`\``;
  const parsed2 = parseExplanationResponse(markdownResponse);
  console.assert(parsed2.summary === 'Test summary', 'Markdown response parsed');

  // Invalid response falls back
  const invalidResponse = 'not json at all';
  const fallback = parseExplanationResponse(invalidResponse);
  console.assert(fallback.summary.includes('unavailable'), 'Fallback for invalid JSON');
  console.assert(fallback.confidence === 'MEDIUM', 'Fallback confidence');

  // Missing fields falls back
  const incompleteResponse = '{"summary": "test"}';
  const fallback2 = parseExplanationResponse(incompleteResponse);
  console.assert(fallback2.summary.includes('unavailable'), 'Fallback for missing fields');

  // Confidence normalization
  const lowConfidence = parseExplanationResponse('{"summary":"x","drivers":[],"risks":[],"confidence":"low"}');
  console.assert(lowConfidence.confidence === 'LOW', 'Lowercase confidence normalized');

  console.log('parseExplanationResponse test passed');
}

function testRateLimiter() {
  const limiter = new RateLimiter(5); // 5 per minute

  // Should allow 5 requests
  for (let i = 0; i < 5; i++) {
    console.assert(limiter.tryConsume() === true, `Request ${i + 1} allowed`);
  }

  // 6th should be denied
  console.assert(limiter.tryConsume() === false, '6th request denied');

  // Retry after should be positive
  const retryMs = limiter.getRetryAfterMs();
  console.assert(retryMs > 0, 'Retry after is positive');

  console.log('RateLimiter test passed');
}

function testFallback() {
  const fallback = getFallbackExplanation();
  console.assert(fallback.summary.includes('unavailable'), 'Fallback has summary');
  console.assert(Array.isArray(fallback.drivers), 'Fallback has drivers array');
  console.assert(Array.isArray(fallback.risks), 'Fallback has risks array');
  console.assert(fallback.confidence === 'MEDIUM', 'Fallback confidence is MEDIUM');

  console.log('getFallbackExplanation test passed');
}

function runTests() {
  testBuildPrompt();
  testParseResponse();
  testRateLimiter();
  testFallback();
  console.log('\nAll Gemini tests passed!');
}

runTests();