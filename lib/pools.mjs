// Messages the flooders post. Pool membership is the ground truth for the accuracy
// number in the bot's summary; Jev only ever sees the text.

export const HOSTILE = [
  'nobody asked for your opinion, go away',
  "you are genuinely the worst player I've ever watched",
  'lmao imagine being this bad, uninstall',
  'this streamer is a clown and so is everyone in chat',
  'shut up already, no one likes you',
  "you're so dumb it hurts to read your messages",
  'get out of this server, loser',
  'your content is trash and you should quit',
  'cry about it, crybaby',
  'embarrassing. do everyone a favor and log off',
  'every word you type makes this chat worse',
  'stop talking, your takes are braindead',
  'ratio + you fell off + nobody cares',
];

// Includes tricky-but-fine lines: negative words that aren't aimed at a person.
export const NORMAL = [
  'gg that was a close one',
  'this boss is absolutely killing me lol',
  'I hate how catchy this song is',
  'that play was sick, how did you pull that off',
  'lag is terrible today, anyone else?',
  'welcome back everyone!',
  'ok that was a terrible decision by me lmao',
  'can someone link the patch notes?',
  'this game is brutal but I love it',
  'brb grabbing food',
  'no way, that ending was insane',
  'honestly the new update kinda sucks, the menus are confusing',
  "you're crazy good at this",
  "lol I died again, I'm so bad at this",
];

export function pick(ratio) {
  const hostile = Math.random() < ratio;
  const pool = hostile ? HOSTILE : NORMAL;
  return { hostile, text: pool[Math.floor(Math.random() * pool.length)] };
}
