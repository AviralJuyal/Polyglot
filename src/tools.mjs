import { InputError } from './config.mjs';
import { retrieve } from './rag.mjs';

export const toolDefinitions = [
  { name: 'calculator', description: 'Evaluate an arithmetic expression using numbers, parentheses, +, -, *, and /.',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'get_weather', description: 'Get current weather for a city from Open-Meteo.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'search_documents', description: 'Search the selected document collection for relevant passages.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
];

// A tiny recursive-descent parser is intentionally narrower than JavaScript eval().
export function calculate(expression) {
  if (typeof expression !== 'string' || expression.length > 120 || !/^[0-9+*/().\s-]+$/.test(expression)) {
    throw new InputError('Invalid arithmetic expression');
  }
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/-]/g) || [];
  let index = 0;
  function factor() {
    const token = tokens[index++];
    if (token === '-') return -factor();
    if (token === '+') return factor();
    if (token === '(') {
      const value = sum();
      if (tokens[index++] !== ')') throw new InputError('Unmatched parenthesis');
      return value;
    }
    if (!token || !/^\d/.test(token)) throw new InputError('Invalid arithmetic expression');
    return Number(token);
  }
  function product() {
    let value = factor();
    while (tokens[index] === '*' || tokens[index] === '/') {
      const op = tokens[index++], rhs = factor();
      if (op === '/' && rhs === 0) throw new InputError('Division by zero');
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++], rhs = product();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }
  const value = sum();
  if (index !== tokens.length || !Number.isFinite(value)) throw new InputError('Invalid arithmetic expression');
  return value;
}

async function weather(city, signal) {
  if (typeof city !== 'string' || city.length < 2 || city.length > 80) throw new InputError('City must be 2–80 characters');
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, { signal: boundedSignal });
  if (!geo.ok) throw new Error('Weather lookup is unavailable');
  const place = (await geo.json()).results?.[0];
  if (!place) return { error: 'City not found' };
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,weather_code');
  const response = await fetch(url, { signal: boundedSignal });
  if (!response.ok) throw new Error('Weather lookup is unavailable');
  return { location: `${place.name}, ${place.country}`, current: (await response.json()).current };
}

export async function executeTool(name, input, { db, collectionId, retrieval, signal }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid tool arguments');
  if (name === 'calculator') return JSON.stringify({ result: calculate(input.expression) });
  if (name === 'get_weather') return JSON.stringify(await weather(input.city, signal));
  if (name === 'search_documents') {
    if (!collectionId) return JSON.stringify({ error: 'No document collection selected' });
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) throw new InputError('Invalid document query');
    const matches = await retrieve(db, collectionId, input.query, retrieval, signal);
    // Citation labels are assigned by the chat orchestrator across all searches in a turn.
    return JSON.stringify({ matches: matches.map(item => ({ chunkId: item.id,
      filename: item.filename, ordinal: item.ordinal, text: item.text, score: item.score })) });
  }
  throw new InputError('Unknown tool');
}
