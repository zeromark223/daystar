/**
 * Built-in scenarios for the web UI. Options are written as on the command line
 * (without the dashes); anything left out takes its default. The UI can clone
 * one into the browser's storage and edit it there.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  options: Record<string, string | boolean>;
}

export const TEMPLATES: Template[] = [
  {
    id: "smoke",
    name: "Smoke test",
    description: "A handful of bots for a minute: is the server up, do joins, moves and chat work?",
    options: { steps: "10,25", hold: "10", ramp: "50", "chat-every": "10" },
  },
  {
    id: "step-ramp",
    name: "Step ramp",
    description: "One big room, growing in steps; stops at the first step that misses a target.",
    options: { steps: "100,250,500,1000", hold: "30", ramp: "100" },
  },
  {
    id: "continuous",
    name: "Continuous ramp to 1,000",
    description: "Bots keep arriving at 20 a second up to 1,000, then hold two minutes; a row every 5 seconds.",
    options: { max: "1000", ramp: "20", hold: "120", "report-every": "5" },
  },
  {
    id: "ceiling",
    name: "Find the ceiling",
    description: "Big steps until something gives: the last passing row is the room's capacity.",
    options: { steps: "500,1000,1500,2000,3000", hold: "40", ramp: "200", "chat-every": "60" },
  },
  {
    id: "small-rooms",
    name: "Many small rooms",
    description: "Meetups instead of one hall: rooms of 20, up to 1,000 bots in all.",
    options: { steps: "200,500,1000", "room-size": "20", hold: "30" },
  },
  {
    id: "voice",
    name: "Voice rooms",
    description: "Rooms of 25 with a host and 3 speakers talking (real Opus frames); checks voice delay and loss.",
    options: { max: "200", "room-size": "25", speakers: "4", ramp: "50", hold: "120", "report-every": "10" },
  },
  {
    id: "my-room",
    name: "Fill my room",
    description: "150 guests in a room you host, 60% of them walking: set Room to your room's id or invite link.",
    options: { room: "", max: "150", ramp: "150", hold: "300", moving: "0.6", "chat-every": "0", "report-every": "10" },
  },
  {
    id: "audience",
    name: "Quiet audience soak",
    description: "500 mostly idle guests for almost ten minutes, like a talk's audience: memory and GC over time.",
    options: { max: "500", ramp: "50", moving: "0.1", "chat-every": "60", hold: "580", "report-every": "10" },
  },
];
