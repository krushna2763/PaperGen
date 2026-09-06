/**
 * Text Cleaner Module
 * Safe normalization of raw extracted PDF text without altering academic meaning
 */

export const textCleaner = {
  /**
   * Clean and normalize raw extracted text
   * @param {string} rawText - Unprocessed text extracted from PDF
   * @returns {string} Sanitized, readable text with preserved question boundaries
   */
  clean(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return '';
    }

    let text = rawText;

    // 1. Normalize line endings to standard LF (\n)
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 2. Remove null bytes and non-printable control characters (preserve newlines and tabs)
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 3. Normalize non-standard spaces (non-breaking spaces, zero-width spaces)
    text = text.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');

    // 4. Clean line by line while preserving question numbering and indentation
    const lines = text.split('\n');
    const cleanedLines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Trim outer whitespace of the line
      line = line.trim();

      // Skip common standalone header/footer page markers like "Page 1 of 4", "-- 1 of 1 --", "-- 1 --", "1 / 4"
      if (/^(?:page\s+\d+(?:\s+of\s+\d+)?|[-–—]+\s*\d+\s*(?:of\s*\d+\s*)?[-–—]+|\d+\s*\/\s*\d+)$/i.test(line)) {
        continue;
      }

      // Collapse multiple consecutive horizontal spaces into single space within the line
      line = line.replace(/[ \t]{2,}/g, ' ');

      cleanedLines.push(line);
    }

    // 5. Join lines back
    text = cleanedLines.join('\n');

    // 6. Collapse 3+ consecutive newlines into double newlines for paragraph spacing
    text = text.replace(/\n{3,}/g, '\n\n');

    // 7. Final trim
    return text.trim();
  }
};

export default textCleaner;
