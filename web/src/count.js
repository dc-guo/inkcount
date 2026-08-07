/* Transcripts → word counts, with a guard against recognizer hallucination. */

/**
 * countWords(transcripts) -> { total, perLine, lowConfidence }
 *
 * A line is low-confidence when its transcript matches the recognizer's
 * degenerate-output signature — many tokens, mostly single characters
 * ("a b c d e f g h i") — which happens on crops with no real handwriting.
 * Flagged lines still count (the user sees the flag and judges), they are
 * just never silently trusted.
 */
export function countWords(transcripts) {
  const perLine = [];
  const lowConfidence = [];
  let total = 0;
  for (const raw of transcripts) {
    const tokens = (raw || '').split(/\s+/).filter(Boolean);
    perLine.push(tokens.length);
    total += tokens.length;

    let degenerate = false;
    if (tokens.length >= 5) {
      const singles = tokens.filter((t) => t.length === 1 && t !== 'a' && t !== 'I' && t !== 'A').length;
      degenerate = singles / tokens.length > 0.6;
    }
    lowConfidence.push(degenerate);
  }
  return { total, perLine, lowConfidence };
}
