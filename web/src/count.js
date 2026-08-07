/* Transcripts → word counts, with guards against recognizer hallucination. */

/**
 * countWords(transcripts) -> { total, perLine, lowConfidence }
 *
 * A line is low-confidence when its transcript matches a recognizer
 * hallucination signature, either:
 *  - single-character spam ("a b c d e f g h i"), or
 *  - repetition loops ("of the first time of the first time of the…") —
 *    measured behavior on near-blank crops: fluent words, tiny vocabulary.
 *
 * Flagged lines are shown to the user but EXCLUDED from `total`: a
 * hallucinated line can add 15+ phantom words, which is far worse for a
 * student than dropping a line they can see flagged in the transcript.
 * `perLine` keeps the raw per-line token counts for display.
 */
export function countWords(transcripts) {
  const perLine = [];
  const lowConfidence = [];
  let total = 0;
  for (const raw of transcripts) {
    const tokens = (raw || '').split(/\s+/).filter(Boolean);
    perLine.push(tokens.length);

    let degenerate = false;
    if (tokens.length >= 4) {
      const singles = tokens.filter((t) => t.length === 1 && t !== 'a' && t !== 'I' && t !== 'A').length;
      degenerate = singles / tokens.length > 0.6;
    }
    if (!degenerate && tokens.length >= 6) {
      const unique = new Set(tokens.map((t) => t.toLowerCase())).size;
      degenerate = unique / tokens.length < 0.45; // real English lines sit ~0.8+
    }
    lowConfidence.push(degenerate);
    if (!degenerate) total += tokens.length;
  }
  return { total, perLine, lowConfidence };
}
