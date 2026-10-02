// Identifies a book from photos (cover, spine, copyright page…) with Claude and
// returns listing-ready details.
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODEL = 'claude-opus-5-5';

const str = (description) => ({ type: 'string', description });

// Structured output: every field is required so the shape is always the same;
// unknown values come back as empty strings.
const BOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'subtitle', 'author', 'isbn', 'publisher', 'pub_year', 'edition', 'binding', 'language',
    'genre', 'illustrator', 'signed', 'condition', 'condition_notes', 'ebay_title', 'description',
    'price_low', 'price_high', 'price_reasoning', 'collectible', 'confidence', 'verify'],
  properties: {
    title: str('Main title exactly as printed'),
    subtitle: str('Subtitle, or empty'),
    author: str('Author name(s) as printed; editors/translators noted, e.g. "Jane Doe (ed.)"'),
    isbn: str('ISBN-13 or ISBN-10 digits only if visible in a photo, otherwise empty. Never invent one.'),
    publisher: str('Publisher, or empty if not visible/known'),
    pub_year: str('Publication year of THIS edition/printing if determinable, else empty'),
    edition: str('Edition and printing, e.g. "First Edition, First Printing", "Book Club Edition", "Later printing", or empty'),
    binding: { type: 'string', enum: ['Hardcover', 'Hardcover w/ DJ', 'Paperback', 'Mass Market', 'Leather', 'Other', ''] },
    language: str('Language of the text, e.g. "English"'),
    genre: str('Short genre / subject, e.g. "Science Fiction", "Cookbook", "Children\'s Picture Book"'),
    illustrator: str('Illustrator if credited, else empty'),
    signed: { type: 'string', enum: ['Yes', 'No', 'Unknown'] },
    condition: { type: 'string', enum: ['As New', 'Fine', 'Near Fine', 'Very Good', 'Good', 'Fair', 'Poor', ''], description: 'Booksellers\' grading judged from visible wear; empty if the photos are not enough to judge' },
    condition_notes: str('Visible flaws a buyer should know (edge wear, chips, sunning, stains, remainder marks, ex-library). Empty if none visible.'),
    ebay_title: str('eBay listing title, at most 80 characters: Title + Author + key selling points (1st Edition, Signed, HC/DJ, year). No ALL CAPS words except standard abbreviations, no "L@@K"'),
    description: str('Buyer-facing listing description, 2-4 short plain-text paragraphs separated by blank lines: what the book is, edition/printing details, physical description and condition. Factual, no hype, no invented facts.'),
    price_low: { type: 'number', description: 'Low end of a reasonable fixed asking price in USD for this copy' },
    price_high: { type: 'number', description: 'High end of a reasonable fixed asking price in USD for this copy' },
    price_reasoning: str('One or two sentences on what drives the value (edition, condition, demand) and that sold comps should be checked'),
    collectible: { type: 'boolean', description: 'True if this belongs in Antiquarian & Collectible (true first editions, signed, pre-1950, scarce) rather than general Books' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in the identification of the specific edition' },
    verify: { type: 'array', items: { type: 'string' }, description: 'Specific things the seller should check before listing, e.g. "Confirm number line on copyright page shows 1"' },
  },
};

const SYSTEM = `You are an expert antiquarian and used bookseller who prepares eBay listings for a small home book business.
You will see one or more photos of a single book: the first is usually the front cover; others may show the spine, back, title page, copyright page, or flaws.
Identify the book and the specific edition as precisely as the photos allow and fill in every field.
Rules:
- Only state edition, printing, year, ISBN or signature details that the photos support. If you are inferring, say so in "verify" and lower "confidence".
- Never invent an ISBN. Leave fields empty rather than guessing.
- Grade condition conservatively from what is visible; mention anything you cannot see (e.g. "interior not shown") in "verify".
- Prices are an estimate for a fixed-price listing of this copy; the seller will check sold listings.`;

export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function imageBlock(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new AiError(400, 'Photos must be JPEG, PNG, WebP or GIF images');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

let defaultClient = null;
export function hasAiCredentials(env = process.env) {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** images: data URLs, cover first. Returns the parsed book details. */
export async function identifyBook(images, { client } = {}) {
  if (!Array.isArray(images) || !images.length) throw new AiError(400, 'Add at least one photo');
  if (images.length > 6) throw new AiError(400, 'Use up to 6 photos for identification');
  const content = images.map(imageBlock);
  if (!client) {
    if (!hasAiCredentials()) throw new AiError(503, 'AI isn\'t set up yet: the server needs an ANTHROPIC_API_KEY (see README).');
    defaultClient ??= new Anthropic();
  }
  const api = client || defaultClient;
  content.push({ type: 'text', text: images.length > 1 ? `Identify this book from the ${images.length} photos (photo 1 is the cover).` : 'Identify this book from the cover photo.' });

  let response;
  try {
    response = await api.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: BOOK_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError(503, 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
    if (err instanceof Anthropic.RateLimitError) throw new AiError(429, 'The AI service is busy. Try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new AiError(400, `The AI couldn't read those photos: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new AiError(502, `AI service error (${err.status ?? 'network'}). Try again.`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new AiError(422, 'The AI declined to identify these photos. Fill in the details by hand.');
  if (response.stop_reason === 'max_tokens') throw new AiError(502, 'The AI response was cut off. Try again with fewer photos.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const book = JSON.parse(text);
    book.ebay_title = String(book.ebay_title || '').slice(0, 80);
    return book;
  } catch {
    throw new AiError(502, 'The AI returned something unexpected. Try again.');
  }
}
