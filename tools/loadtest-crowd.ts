/**
 * What load test bots say and are called, so a room full of them looks like a
 * crowd (for demos) rather than a test: chat lines people send at a meetup in
 * orbit, and first names (--names people).
 */

export const CHAT_LINES = [
  "hi everyone 👋",
  "hello from Berlin!",
  "morning! or evening, depending on where you are",
  "first time here, this looks amazing",
  "the sun in the middle is so pretty",
  "how do I get closer to the stage?",
  "can everyone hear the speakers ok?",
  "audio is great on my side",
  "love the little planets",
  "who else is just flying around in circles 😄",
  "brb, grabbing coffee ☕",
  "back!",
  "lol",
  "haha same",
  "+1",
  "agreed",
  "good point",
  "this is such a nice way to meet",
  "is there a recording later?",
  "what time does the next talk start?",
  "anyone from the design team here?",
  "waves at everyone 🌟",
  "so many people today!",
  "great question",
  "can you share the slides after?",
  "the orbit thing when the host gathers everyone is wild",
  "my planet is purple, find me 💜",
  "greetings from Ho Chi Minh City 🇻🇳",
  "hello from Toronto",
  "just joined, what did I miss?",
  "thanks for organizing this!",
  "👏👏👏",
  "🔥",
  "this beats a grid of video tiles",
  "how many people can fit in one room?",
  "following the crowd to the sun ☀️",
  "anyone want to chat about the roadmap?",
  "my wifi is a bit shaky, sorry if I lag",
  "nice to see familiar faces",
  "where is everyone gathering?",
  "I'll be near the top right if anyone wants to talk",
  "that was a really good demo",
  "q: will this work on mobile?",
  "it does, I'm on my phone right now 📱",
  "the joystick on mobile works well",
  "taking notes 📝",
  "oops wrong chat 😅",
  "cheers 🥂",
  "see you all at the next one",
  "gotta run soon, great session",
];

const FIRST_NAMES = [
  "Maya", "Leo", "Aria", "Noah", "Linh", "Kai", "Zoe", "Omar", "Ivy", "Lucas",
  "Mia", "Ethan", "Hana", "Diego", "Nora", "Arjun", "Elena", "Minh", "Chloe", "Felix",
  "Sofia", "Hugo", "Amara", "Ravi", "Lena", "Tomas", "Yuki", "Isla", "Mateo", "Priya",
  "Jonas", "Lucia", "Ben", "Anh", "Clara", "Sam", "Nina", "Theo", "Aiko", "Marco",
  "Sara", "Max", "Leila", "Oscar", "Mei", "Daniel", "Freya", "Tariq", "Emma", "Jin",
  "Alex", "Rosa", "Finn", "Nadia", "Kenji", "Lily", "Ahmed", "Vera", "Tuan", "Grace",
];

/** A name for bot `i`: first names, then with an initial so they stay distinct ("Maya K."). */
export function personName(i: number): string {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const round = Math.floor(i / FIRST_NAMES.length);
  return round === 0 ? first : `${first} ${String.fromCharCode(65 + ((round * 7) % 26))}.`;
}

/** A chat line, not the same as `last`. */
export function chatLine(last: string): string {
  for (;;) {
    const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
    if (line !== last) return line;
  }
}
