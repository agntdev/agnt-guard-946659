import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";

const COMMANDS = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show all commands" },
  { command: "warn", description: "Warn a member" },
  { command: "warnings", description: "Check a member's warnings" },
  { command: "resetwarn", description: "Remove a member's warnings" },
  { command: "mute", description: "Mute a member" },
  { command: "unmute", description: "Unmute a member" },
  { command: "kick", description: "Remove a member from the group" },
  { command: "ban", description: "Ban a member" },
  { command: "unban", description: "Unban a member" },
  { command: "rules", description: "Show group rules" },
] as const;

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  await setDefaultCommands(bot, COMMANDS.slice(2));
  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
