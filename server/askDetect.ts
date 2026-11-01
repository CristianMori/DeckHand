/**
 * Does this reply end by asking the user something? A plain heuristic on the
 * end of the reply: a turn that finishes with a question in text is how most
 * questions arrive, and no hook says so. Answers the text to show the user,
 * or undefined when the reply doesn't ask.
 */
const TEXT_CAP = 600;
const SHORT_CLOSER = 120; // "Which one? Either is quick to do." still asks
const CLOSING_MARKS = /[*_`"'”’)\]\s]+$/;
const ASKS_IN_WORDS =
  /\b(let me know|tell me|your call|please (confirm|choose|pick|decide)|waiting (for|on) your|need (your|you to))\b(?!.*\bif you\b)/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s/;

const endsAsking = (s: string) => s.replace(CLOSING_MARKS, '').endsWith('?');

export function askingText(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const text = reply
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, '\n\n') // code is not the question, nor is a ? inside it
    .replace(/`[^`\n]*`/g, 'code')
    .replace(/https?:\/\/\S+/g, 'link');
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^[-*_\s]+$/.test(p));
  const last = paragraphs.at(-1);
  if (!last) return undefined;

  const show = (p: string) => (p.length > TEXT_CAP ? `…${p.slice(-TEXT_CAP)}` : p);
  const before = paragraphs.at(-2);
  // "Which one?" followed by the options to pick from
  if (before && last.split('\n').every((l) => LIST_ITEM.test(l)) && endsAsking(before)) return show(`${before}\n${last}`);

  const sentences = last.split(/(?<=[.!?:][*_`"'”’)\]]*)\s+/).filter(Boolean);
  const end = sentences.at(-1) ?? '';
  const prev = sentences.at(-2);
  if (endsAsking(end) || (prev && endsAsking(prev) && end.length <= SHORT_CLOSER) || ASKS_IN_WORDS.test(end)) {
    return show(last);
  }
  return undefined;
}
