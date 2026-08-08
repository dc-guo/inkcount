/* Transcripts → word counts, with guards against recognizer hallucination. */

/**
 * countWords(transcripts) -> { total, perLine, lowConfidence }
 *
 * A WORD is a whitespace-separated token containing at least one letter or
 * digit. Pure punctuation/symbol tokens never count: the recognizer renders
 * a lone "!" as "&" or similar, and a student's "Wow!" must be one word, not
 * two. (The v1 Python prototype had this rule; v2 initially lost it.)
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
 * `perLine` keeps the per-line WORD counts for display.
 */
export function countWords(transcripts) {
  const perLine = [];
  const lowConfidence = [];
  let total = 0;
  for (const raw of transcripts) {
    const words = (raw || '').split(/\s+/).filter((t) => /[a-zA-Z0-9]/.test(t));
    perLine.push(words.length);

    let degenerate = false;
    if (words.length >= 4) {
      const singles = words.filter((t) => t.length === 1 && t !== 'a' && t !== 'I' && t !== 'A').length;
      degenerate = singles / words.length > 0.6;
    }
    if (!degenerate && words.length >= 6) {
      const unique = new Set(words.map((t) => t.toLowerCase())).size;
      degenerate = unique / words.length < 0.45; // real English lines sit ~0.8+
    }
    lowConfidence.push(degenerate);
    if (!degenerate) total += words.length;
  }
  return { total, perLine, lowConfidence };
}
